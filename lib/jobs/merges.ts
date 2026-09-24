// User actions on feature merges (DESIGN.md §6.3): accept or reject a
// suggestion, unmerge or rename a merged module.
//
// Accept and Unmerge only write (or delete) the merged module and then
// regroup (./module-tier.ts), which applies membership exactly the way
// re-analysis does — one code path owns who owns which file.
//
// Kept out of lib/jobs' barrel like ./analyze.ts: it pulls in the folder
// clustering from lib/analysis. Routes import it directly.

import { randomUUID } from "node:crypto";
import {
  deleteComponent,
  deleteMergeSuggestion,
  getComponentById,
  getFileOwnerMap,
  getMergeSuggestion,
  linkComponentToRepo,
  listMergeSuggestions,
  reassignFindingsWithoutFile,
  setComponentDescription,
  setMergeSuggestionStatus,
  upsertComponent,
} from "@/lib/neo4j";
import type { ComponentRecord, MergeSuggestionRecord } from "@/lib/neo4j";
import type { JobLogger } from "./analyze";
import { regroupRepo, type ModuleTierCounts } from "./module-tier";
import { folderOfPattern, isUnderFolder } from "./ownership";

export class MergeActionError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function mergedModuleId(repoId: string): string {
  return `${repoId}:feature:${randomUUID()}`;
}

function matchesAny(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const dir = folderOfPattern(pattern);
    return dir === null ? filePath === pattern : isUnderFolder(filePath, dir);
  });
}

/** The folder modules that currently own files matched by `patterns`. */
async function absorbedModuleIds(repoId: string, patterns: readonly string[]): Promise<string[]> {
  const owners = await getFileOwnerMap(repoId);
  const ids = new Set<string>();
  for (const [path, owner] of owners) {
    if (matchesAny(path, patterns) && owner.startsWith(`${repoId}:module:`)) ids.add(owner);
  }
  return [...ids].sort();
}

/** Merges the descriptions of `ids` into a stored `absorbedDescriptions` JSON object. */
async function withAbsorbedDescriptions(previous: string | undefined, ids: readonly string[]): Promise<string> {
  let saved: Record<string, string> = {};
  try {
    saved = previous ? (JSON.parse(previous) as Record<string, string>) : {};
  } catch {
    saved = {};
  }
  for (const id of ids) {
    const description = (await getComponentById(id))?.description;
    if (description && !saved[id]) saved[id] = description;
  }
  return JSON.stringify(saved);
}

export interface AcceptResult {
  componentId: string;
  counts: ModuleTierCounts;
}

/**
 * Writes one open suggestion into the module tier — creates the merged
 * module (`merge`) or adds the members to an existing one (`extend`,
 * `move-file`) — and deletes the suggestion. Does **not** regroup: the
 * caller does that once, after however many suggestions it applied.
 * Returns the merged module's id and whether it was newly created.
 */
async function applySuggestion(
  repoId: string,
  suggestion: MergeSuggestionRecord,
  log: JobLogger
): Promise<{ componentId: string; created: boolean }> {
  const absorbed = await absorbedModuleIds(repoId, suggestion.members);

  if (suggestion.kind === "merge") {
    const componentId = mergedModuleId(repoId);
    await upsertComponent({
      id: componentId,
      repoId,
      name: suggestion.name,
      createdBy: "user",
      pathPatterns: [...suggestion.members],
      tier: "module",
      origin: "merge",
      absorbedModuleIds: absorbed,
      absorbedDescriptions: await withAbsorbedDescriptions(undefined, absorbed),
    });
    await linkComponentToRepo(componentId, repoId);
    await deleteMergeSuggestion(suggestion.id);
    log(`created merged module "${suggestion.name}" from ${suggestion.members.join(", ")}`);
    return { componentId, created: true };
  }

  const target = suggestion.targetComponentId ? await getComponentById(suggestion.targetComponentId) : null;
  if (!target || target.origin !== "merge") {
    await deleteMergeSuggestion(suggestion.id);
    throw new MergeActionError("The module this suggestion adds to no longer exists.", 409);
  }
  await upsertComponent({
    ...target,
    pathPatterns: [...new Set([...target.pathPatterns, ...suggestion.members])],
    absorbedModuleIds: [...new Set([...(target.absorbedModuleIds ?? []), ...absorbed])],
    absorbedDescriptions: await withAbsorbedDescriptions(target.absorbedDescriptions, absorbed),
  });
  await deleteMergeSuggestion(suggestion.id);
  log(`added ${suggestion.members.length} member(s) to "${target.name}"`);
  return { componentId: target.id, created: false };
}

/**
 * Accepts one suggestion, then regroups.
 * The heuristic name is used until AI naming (./merge-naming.ts) replaces it.
 */
export async function acceptMergeSuggestion(
  repoId: string,
  suggestionId: string,
  log: JobLogger
): Promise<AcceptResult> {
  const suggestion = await getMergeSuggestion(repoId, suggestionId);
  if (!suggestion) throw new MergeActionError("No such suggestion.", 404);
  if (suggestion.status !== "open") throw new MergeActionError("This suggestion was rejected — reopen it first.", 409);

  const { componentId } = await applySuggestion(repoId, suggestion, log);
  const counts = await regroupRepo(repoId, log);
  return { componentId, counts };
}

/** Whether two member patterns can claim the same file (same/nested folders, or a file inside a folder). */
export function patternsOverlap(a: string, b: string): boolean {
  const dirA = folderOfPattern(a);
  const dirB = folderOfPattern(b);
  if (dirA === null && dirB === null) return a === b;
  if (dirA === null) return isUnderFolder(a, dirB as string);
  if (dirB === null) return isUnderFolder(b, dirA);
  return dirA === dirB || isUnderFolder(dirA, dirB) || isUnderFolder(dirB, dirA);
}

export interface AcceptAllResult {
  /** Suggestions applied. */
  accepted: number;
  /** Open suggestions left alone because they overlapped a stronger one already applied (they are re-evaluated by the regroup). */
  skipped: number;
  /** Ids of the merged modules this created — the ones still carrying a heuristic name. */
  createdComponentIds: string[];
  counts: ModuleTierCounts;
}

/**
 * Accepts every open suggestion in one go, strongest first, then regroups
 * once. A suggestion whose members overlap one already applied in this
 * pass is skipped rather than applied on top of it (two merges both
 * claiming `components/map` would make the result depend on pattern
 * lengths); the regroup recomputes suggestions, so a skipped one comes
 * back in whatever form still makes sense (often as an "Add to …").
 */
export async function acceptAllMergeSuggestions(repoId: string, log: JobLogger): Promise<AcceptAllResult> {
  const open = (await listMergeSuggestions(repoId))
    .filter((s) => s.status === "open")
    .sort((a, b) => b.score - a.score);

  const claimed: string[] = [];
  const createdComponentIds: string[] = [];
  let accepted = 0;
  let skipped = 0;
  for (const suggestion of open) {
    if (suggestion.members.some((m) => claimed.some((c) => patternsOverlap(m, c)))) {
      skipped++;
      continue;
    }
    try {
      const { componentId, created } = await applySuggestion(repoId, suggestion, log);
      if (created) createdComponentIds.push(componentId);
      claimed.push(...suggestion.members);
      accepted++;
    } catch (error) {
      if (!(error instanceof MergeActionError)) throw error;
      skipped++;
    }
  }

  log(`accepted ${accepted} suggestion(s) at once, skipped ${skipped} overlapping`);
  const counts = await regroupRepo(repoId, log);
  return { accepted, skipped, createdComponentIds, counts };
}

export async function rejectMergeSuggestion(repoId: string, suggestionId: string): Promise<MergeSuggestionRecord> {
  const updated = await setMergeSuggestionStatus(repoId, suggestionId, "rejected");
  if (!updated) throw new MergeActionError("No such suggestion.", 404);
  return updated;
}

export async function reopenMergeSuggestion(repoId: string, suggestionId: string): Promise<MergeSuggestionRecord> {
  const updated = await setMergeSuggestionStatus(repoId, suggestionId, "open");
  if (!updated) throw new MergeActionError("No such suggestion.", 404);
  return updated;
}

async function loadMergedModule(repoId: string, componentId: string): Promise<ComponentRecord> {
  const component = await getComponentById(componentId);
  if (!component || component.repoId !== repoId) throw new MergeActionError("No such module.", 404);
  if (component.origin !== "merge") throw new MergeActionError("Only merged modules can be changed here.", 400);
  return component;
}

/**
 * Unmerge: delete the merged module and regroup, so its folders fall back
 * to their folder modules and findings follow their files back. The merge
 * suggestion it came from is remembered as rejected, so it doesn't pop
 * straight back up.
 */
export async function unmergeModule(repoId: string, componentId: string, log: JobLogger): Promise<ModuleTierCounts> {
  const component = await loadMergedModule(repoId, componentId);

  const fallback = component.absorbedModuleIds?.[0];
  if (fallback) await reassignFindingsWithoutFile(repoId, component.id, fallback);
  await deleteComponent(component.id);
  log(`unmerged "${component.name}"`);

  const counts = await regroupRepo(repoId, log);

  // The folder modules came back as fresh nodes; give them their
  // descriptions back (never over one written in the meantime).
  let saved: Record<string, string> = {};
  try {
    saved = component.absorbedDescriptions ? (JSON.parse(component.absorbedDescriptions) as Record<string, string>) : {};
  } catch {
    saved = {};
  }
  for (const [id, description] of Object.entries(saved)) {
    await setComponentDescription(id, description);
  }

  const members = [...component.pathPatterns].sort().join(",");
  const reappeared = (await listMergeSuggestions(repoId)).find(
    (s) => s.status === "open" && s.kind === "merge" && [...s.members].sort().join(",") === members
  );
  if (reappeared) await setMergeSuggestionStatus(repoId, reappeared.id, "rejected");
  return counts;
}

export async function renameMergedModule(
  repoId: string,
  componentId: string,
  name: string,
  description?: string
): Promise<ComponentRecord> {
  const component = await loadMergedModule(repoId, componentId);
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (!trimmed) throw new MergeActionError("A name is required.", 400);
  return upsertComponent({
    ...component,
    name: trimmed.slice(0, 60),
    description: description === undefined ? component.description : description.trim() || undefined,
  });
}
