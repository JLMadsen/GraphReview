// The AI labeling job body.
//
// This is the piece that completes the three-tier hierarchy. Static analysis
// can only produce the *module* tier from folder structure; the domain tier
// does not label reliably from folder structure alone and needs either an
// LLM pass or manual tagging. This job is that LLM pass.
//
// Pipeline: load the repo and its module-tier components (+ file paths and
// dependency names) → load and decrypt the AI provider settings →
// phase 1, bucket the modules into ≤8 domains → persist the domain tier →
// phase 2, one description sentence per module, in batches → persist each
// batch, never clobbering a description that already has text unless the
// user explicitly asked for a forced relabel.
//
// Kept out of lib/jobs' barrel on purpose, exactly like `./analyze.ts` and
// `./review.ts`: it is the unit of work (importable from a script or test
// without starting a queue consumer) and it pulls in lib/ai, which the app
// bundle has no reason to carry just because a route imported `@/lib/jobs`
// to enqueue something.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { UnrecoverableError } from "bullmq";
import { labelComponents } from "@/lib/ai";
import type { AiProviderConfig, LabelInput, LabelModuleInput } from "@/lib/ai";
import { decrypt } from "@/lib/crypto";
import {
  deleteAutoDomainComponents,
  getActiveAiProvider,
  getRepoById,
  linkComponentChildOf,
  linkComponentToRepo,
  listModuleLabelInputs,
  setComponentDescription,
  upsertComponent,
} from "@/lib/neo4j";
import type { RepoRecord } from "@/lib/neo4j";
import type { JobLogger } from "./analyze";
import type {
  LabelJob,
  LabelJobData,
  LabelJobResult,
  LabelProgress,
} from "./label-queue";
import { repoCacheDir, validateLocalRepoPath } from "./source";

/** Sample paths sent per module ("the file paths in a cluster … never full file contents"). */
const SAMPLE_FILES_PER_MODULE = 3;
/** Dependency names sent per module. */
const DEPENDS_ON_PER_MODULE = 5;
/** How much of a README is worth sending as repo context. */
const README_CHARS = 800;
const README_CANDIDATES = ["README.md", "readme.md", "README", "Readme.md", "README.rst"];

// ---------------------------------------------------------------------------
// AI provider settings
// ---------------------------------------------------------------------------

/**
 * Reads and decrypts the currently *active* saved AI provider (multiple
 * providers can be saved, lib/neo4j/ai-provider.ts, with one
 * marked active at a time).
 *
 * Deliberately a local copy of `./review.ts`'s equivalent rather than a
 * shared helper: that module is the review pipeline and is owned/edited
 * independently, and this is eight lines of settings validation. Both check
 * all three fields together, because a half-configured provider can only
 * produce a confusing failure deep inside an HTTP call. The API route runs
 * the same check *before* enqueueing (returning `ai_not_configured`); this
 * is the worker-side backstop for the window where the active provider is
 * changed/deleted between enqueue and execution.
 */
async function loadAiConfig(): Promise<AiProviderConfig> {
  const provider = await getActiveAiProvider();
  const missing: string[] = [];
  if (!provider?.baseUrl) missing.push("base URL");
  if (!provider?.apiKeyEncrypted) missing.push("API key");
  if (!provider?.model) missing.push("model name");

  if (missing.length > 0 || !provider) {
    throw new UnrecoverableError(
      `AI provider is not fully configured — missing ${missing.join(", ")}. Set it in Settings.`
    );
  }

  let apiKey: string;
  try {
    apiKey = decrypt(provider.apiKeyEncrypted as string);
  } catch {
    throw new UnrecoverableError(
      "The stored AI API key could not be decrypted — has SESSION_SECRET changed? Re-enter it in Settings."
    );
  }

  return {
    baseUrl: provider.baseUrl,
    apiKey,
    model: provider.model,
  };
}

// ---------------------------------------------------------------------------
// Repo context
// ---------------------------------------------------------------------------

/**
 * A short README excerpt, if one can be read cheaply — sending
 * "perhaps a README/package.json snippet" alongside the paths.
 *
 * Entirely best-effort: a repo whose source isn't on disk (never cloned, or
 * a local path outside the bind mount) simply gets labeled from its
 * module names and paths, which is the input the feature is designed around
 * anyway. Never throws.
 */
async function readReadmeSnippet(repo: RepoRecord, log: JobLogger): Promise<string | undefined> {
  let dir: string | undefined;
  try {
    dir = repo.provider === "local" && repo.localPath
      ? await validateLocalRepoPath(repo.localPath)
      : repoCacheDir(repo.id);
  } catch {
    return undefined;
  }
  if (!dir) return undefined;

  for (const candidate of README_CANDIDATES) {
    try {
      const text = await readFile(path.join(dir, candidate), "utf8");
      const snippet = text.slice(0, README_CHARS).trim();
      if (snippet.length > 0) {
        log(`using ${candidate} as repo context (${snippet.length} chars)`);
        return snippet;
      }
    } catch {
      /* next candidate */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Domain persistence
// ---------------------------------------------------------------------------

/** URL/id-safe form of a domain name — `"Docs & Tests"` -> `"docs-tests"`. */
export function domainSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "domain";
}

/** `<repoId>:domain:<slug>` — the same `<repoId>:<tier>:<key>` convention `analyze.ts` uses for modules and files. */
export function domainNodeId(repoId: string, slug: string): string {
  return `${repoId}:domain:${slug}`;
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * Runs one full labeling pass. Throws only on failures that make the whole
 * run impossible (repo gone, AI unconfigured, the domain call failing) —
 * a description batch that fails is absorbed by lib/ai/label.ts, which
 * simply returns fewer descriptions.
 */
export async function runLabelJob(
  data: LabelJobData,
  job?: Pick<LabelJob, "updateProgress">,
  log: JobLogger = (message) => console.log(`[label] ${message}`)
): Promise<LabelJobResult> {
  const startedAt = Date.now();
  const { repoId, force = false } = data;

  const repo = await getRepoById(repoId);
  if (!repo) {
    throw new UnrecoverableError(`Repo ${repoId} no longer exists — nothing to label.`);
  }

  const aiConfig = await loadAiConfig();
  const modules = await listModuleLabelInputs(repoId);
  log(
    `repo ${repo.name} (${repo.provider}) · ${modules.length} module(s) · model ${aiConfig.model}` +
      (force ? " · force (existing descriptions will be replaced)" : "")
  );

  if (modules.length === 0) {
    throw new UnrecoverableError(
      "This repo has no analyzed module components yet — run an analysis before labeling."
    );
  }

  const readme = await readReadmeSnippet(repo, log);

  const input: LabelInput = {
    repoName: repo.name,
    readme,
    modules: modules.map(
      (module): LabelModuleInput => ({
        id: module.id,
        name: module.name,
        fileCount: module.fileCount,
        sampleFiles: module.filePaths.slice(0, SAMPLE_FILES_PER_MODULE),
        dependsOn: module.dependsOn.slice(0, DEPENDS_ON_PER_MODULE),
      })
    ),
  };

  const progress: LabelProgress = {
    phase: "domains",
    done: 0,
    total: modules.length,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
  const publishProgress = async (): Promise<void> => {
    try {
      // Progress is advisory (a live counter) — a Redis hiccup writing it
      // must never take down a job that is otherwise succeeding.
      await job?.updateProgress({ ...progress });
    } catch {
      /* ignored */
    }
  };
  await publishProgress();

  // Both phases run inside one `labelComponents` call so its own cost
  // accounting stays authoritative; the work between them (persisting the
  // domain tier) happens after, since a domain box is worthless until every
  // module is assigned anyway and the phases are only seconds apart.
  const result = await labelComponents(aiConfig, input, {
    onProgress: async (event) => {
      progress.phase = event.phase;
      progress.done = event.done;
      progress.total = event.total;
      progress.calls = event.calls;
      progress.promptTokens = event.promptTokens;
      progress.completionTokens = event.completionTokens;
      await publishProgress();
    },
  });
  log(
    `model pass done — ${result.domains.length} domain(s), ${result.descriptions.length} description(s), ` +
      `${result.calls} call(s), ${result.usage.promptTokens}+${result.usage.completionTokens} token(s)` +
      (result.parseFailed ? " (some output could not be parsed)" : "")
  );

  // --- Persist the domain tier --------------------------------------------
  //
  // Replace, don't accumulate: the previous run's domains are removed first,
  // so re-labeling can't leave orphaned boxes behind when the model picks
  // different names. Every write below is serial — these MERGE relationships
  // onto shared endpoints, and Neo4j Community deadlocks on parallel
  // relationship writes (see analyze.ts's
  // NEO4J_RELATIONSHIP_WRITE_CONCURRENCY).
  const replacedDomains = await deleteAutoDomainComponents(repoId);
  if (replacedDomains > 0) log(`removed ${replacedDomains} domain(s) from a previous labeling run`);

  const usedSlugs = new Set<string>();
  let domainsWritten = 0;
  for (const domain of result.domains) {
    let slug = domainSlug(domain.name);
    // Two different names can slug identically ("Front End" / "front-end").
    // They are distinct domains to the model, so keep them distinct here.
    if (usedSlugs.has(slug)) {
      let suffix = 2;
      while (usedSlugs.has(`${slug}-${suffix}`)) suffix++;
      slug = `${slug}-${suffix}`;
    }
    usedSlugs.add(slug);

    const domainId = domainNodeId(repoId, slug);
    await upsertComponent({
      id: domainId,
      repoId,
      name: domain.name,
      description: domain.description,
      createdBy: "auto",
      // A domain is defined by its members, not by a path glob — the whole
      // point is that it doesn't correspond to a folder.
      pathPatterns: [],
      tier: "domain",
    });
    await linkComponentToRepo(domainId, repoId);
    for (const moduleId of domain.moduleIds) {
      await linkComponentChildOf(moduleId, domainId);
    }
    domainsWritten += 1;
    log(`domain "${domain.name}" (${slug}) — ${domain.moduleIds.length} module(s)`);
  }

  // --- Persist descriptions ---------------------------------------------
  let describedModules = 0;
  let skipped = 0;
  for (const description of result.descriptions) {
    const updated = await setComponentDescription(description.id, description.description, {
      force,
    });
    if (updated) describedModules += 1;
    else skipped += 1;
  }
  if (skipped > 0) {
    log(
      `kept ${skipped} existing module description(s) — re-run with force to replace them`
    );
  }

  await publishProgress();

  const durationMs = Date.now() - startedAt;
  log(
    `done in ${durationMs}ms — ${domainsWritten} domain(s), ${describedModules} description(s) written, ` +
      `${result.calls} model call(s), ${result.usage.promptTokens}+${result.usage.completionTokens} token(s)`
  );

  return {
    repoId,
    modules: modules.length,
    domains: domainsWritten,
    describedModules,
    replacedDomains,
    calls: result.calls,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    parseFailed: result.parseFailed,
    durationMs,
  };
}
