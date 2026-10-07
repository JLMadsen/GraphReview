// The app map's AI run (DESIGN.md §6.5) — one level per run, on demand.
//
//   grouping    features: the model cuts the file tree into features;
//               architecture: the model corrects the path heuristic's layer
//               per file/folder and describes each layer for this repo;
//               modules: nothing to group (the modules are the cards).
//   placing     features: the files none of the grouping's members cover are
//               listed by full path and the model puts each into a feature
//               (up to two rounds), so one run leaves nothing to the heuristic.
//   explaining  a few cards per call: a real explanation, the files to open
//               first, and a verb + sentence per outgoing connection.
//   saving      one app-map record for the level, replacing the last run.
//
// A `place` run (features only) skips grouping: it starts from the stored
// grouping, places the files it doesn't cover — added since, or missed — and
// re-explains only the cards that grew, keeping everything else.
//
// Cards and edges are assembled by lib/jobs/app-map.ts exactly as the read
// path does, so the explain calls see the same connections the canvas will
// draw. Kept out of lib/jobs' barrel (it pulls in lib/ai), like ./label.ts.

import path from "node:path";
import { UnrecoverableError } from "./runner";
import {
  APP_MAP_TOKEN_BUDGET,
  explainAppCards,
  groupAppFeatures,
  placeAppFiles,
  placeAppLayers,
  type AppExplainCard,
  type AppMapAiFolder,
  type TokenUsage,
} from "@/lib/ai";
import { getAppMapRecords, getRepoById, saveAppMapRecord } from "@/lib/db";
import { APP_LAYERS, type AppMapLevel, type AppMapNodeDTO } from "@/components/graph/app-map-types";
import type { JobLogger } from "./analyze";
import {
  assembleAppMap,
  cardId,
  classifyLayer,
  compactPlacements,
  groupsForLevel,
  heuristicFeatureGroups,
  layerResolver,
  loadAppMapInput,
  toStoredAppMaps,
  uncoveredFiles,
  type StoredAppMap,
  type StoredAppMapEdge,
  type StoredAppMapGroup,
} from "./app-map";
import {
  APP_MAP_CANCELLED_REASON,
  type AppMapJob,
  type AppMapJobData,
  type AppMapJobResult,
  type AppMapProgress,
} from "./app-map-queue";
import { readReadmeSnippet } from "./label";
import { loadAiConfigOrNull } from "./merge-naming";
import { extractDeclarations, readRepoFile, sourceDir } from "./review-context";

/** Files whose declarations are read from disk — enough for any repo this tool is pointed at. */
const MAX_FILES_READ = 2500;
const MAX_DECLARATIONS = 8;
/** Cards per explain call, by level: layers and features are big, modules small. */
const EXPLAIN_BATCH: Record<AppMapLevel, number> = { architecture: 1, features: 2, modules: 4 };
const MAX_OUTGOING_PER_CARD = 12;
/** Placement calls per run: a second round only for what the first left out. */
const MAX_PLACE_ROUNDS = 2;
/** Paths quoted in a log line. */
const LOG_SAMPLE = 8;

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "feature"
  );
}

function sample(items: readonly string[]): string {
  return items.length <= LOG_SAMPLE ? items.join(", ") : `${items.slice(0, LOG_SAMPLE).join(", ")} +${items.length - LOG_SAMPLE} more`;
}

export async function runAppMapJob(
  data: AppMapJobData,
  job?: Pick<AppMapJob, "updateProgress">,
  log: JobLogger = (message) => console.log(`[app-map] ${message}`),
  signal?: AbortSignal
): Promise<AppMapJobResult> {
  const startedAt = Date.now();
  const { repoId, level } = data;
  const mode = data.mode ?? "full";

  const repo = await getRepoById(repoId);
  if (!repo) throw new UnrecoverableError(`Repo ${repoId} no longer exists.`);
  const config = await loadAiConfigOrNull();
  if (!config) {
    throw new UnrecoverableError("AI provider is not fully configured — set the base URL, API key and model in Settings.");
  }

  const input = await loadAppMapInput(repoId);
  if (input.files.length === 0) {
    throw new UnrecoverableError("This repo has no analyzed files yet — run an analysis first.");
  }
  const stored = toStoredAppMaps(await getAppMapRecords(repoId));
  const previous = stored.get(level) ?? null;
  if (mode === "place") {
    if (level !== "features") throw new UnrecoverableError("Only the features level can place files — the other levels cover every file.");
    if (!previous || previous.groups.length === 0) {
      throw new UnrecoverableError("There is no features grouping to place files into yet — group the features first.");
    }
  }
  log(
    `repo ${repo.name} · level ${level}${mode === "place" ? " · placing leftover files" : ""} · ${input.files.length} file(s) · model ${config.model}`
  );

  const progress: AppMapProgress = {
    level,
    phase: mode === "place" ? "placing" : "grouping",
    done: 0,
    total: 0,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
  const publish = async () => {
    try {
      await job?.updateProgress({ ...progress });
    } catch {
      /* advisory only */
    }
  };
  const count = (usage: TokenUsage) => {
    progress.calls += 1;
    progress.promptTokens += usage.promptTokens;
    progress.completionTokens += usage.completionTokens;
  };
  const stopIfCancelled = () => {
    if (signal?.aborted) {
      log(`cancelled after ${progress.calls} model call(s) — nothing was saved`);
      throw new UnrecoverableError(APP_MAP_CANCELLED_REASON);
    }
  };
  await publish();

  // --- Context: declarations per file ---------------------------------------
  const dir = await sourceDir(repo);
  if (!dir) log("no checkout on disk — working from paths and module names only");
  const declarations = new Map<string, string[]>();
  if (dir) {
    for (const file of input.files.slice(0, MAX_FILES_READ)) {
      const source = await readRepoFile(dir, file);
      if (!source) continue;
      declarations.set(
        file,
        extractDeclarations(source)
          .filter((d) => d.indent === 0)
          .map((d) => d.name)
          .filter((name, i, all) => all.indexOf(name) === i)
          .slice(0, MAX_DECLARATIONS)
      );
    }
  }
  let parseFailed = false;

  // --- Grouping --------------------------------------------------------------
  let groups: StoredAppMapGroup[] = [];
  /** The model's feature grouping was unusable, so the heuristic's — which covers every file — stands in. */
  let heuristicFallback = false;
  if (mode === "place") {
    groups = previous!.groups.map((g) => ({ ...g, members: [...g.members] }));
  } else {
    const byDir = new Map<string, string[]>();
    for (const file of input.files) {
      const d = path.posix.dirname(file);
      const key = d === "." ? "" : d;
      byDir.set(key, [...(byDir.get(key) ?? []), file]);
    }
    const folders: AppMapAiFolder[] = [...byDir]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([folder, files]) => {
        const owners = new Map<string, number>();
        for (const f of files) {
          const owner = input.ownerByPath.get(f);
          if (owner) owners.set(owner, (owners.get(owner) ?? 0) + 1);
        }
        const mainModule = input.components.get([...owners].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "");
        return {
          dir: folder,
          module: mainModule?.name,
          moduleDescription: mainModule?.description,
          files: files.map((f) => ({
            name: path.posix.basename(f),
            declarations: declarations.get(f) ?? [],
            layer: classifyLayer(f),
          })),
        };
      });
    const readme = await readReadmeSnippet(repo, log);
    const tree = { repoName: repo.name, readme, folders };

    try {
      if (level === "features") {
        const result = await groupAppFeatures(config, tree, { signal, tokenBudget: APP_MAP_TOKEN_BUDGET });
        count(result.usage);
        if (result.parseFailed) {
          parseFailed = true;
          heuristicFallback = true;
          log("the model's feature grouping was unusable — explaining the heuristic features instead");
          groups = heuristicFeatureGroups(input).map((g) => ({ key: g.key, name: g.name, description: g.description, members: g.files }));
        } else {
          const used = new Set<string>();
          groups = result.features.map((feature) => {
            let key = slug(feature.name);
            for (let n = 2; used.has(key); n++) key = `${slug(feature.name)}-${n}`;
            used.add(key);
            return { key, name: feature.name, description: feature.description, members: feature.members };
          });
          log(`grouped into ${groups.length} feature(s)`);
          if (result.droppedMembers.length > 0) {
            log(`ignored ${result.droppedMembers.length} member(s) naming no file or folder: ${sample(result.droppedMembers)}`);
          }
          if (result.droppedFeatures.length > 0) {
            log(`ignored ${result.droppedFeatures.length} feature(s) past the cap: ${sample(result.droppedFeatures)}`);
          }
        }
      } else if (level === "architecture") {
        const result = await placeAppLayers(config, tree, { signal, tokenBudget: APP_MAP_TOKEN_BUDGET });
        count(result.usage);
        if (result.parseFailed) parseFailed = true;
        const describe = new Map(result.layers.map((l) => [l.layer, l.description]));
        groups = (Object.keys(APP_LAYERS) as Array<keyof typeof APP_LAYERS>).map((layer) => ({
          key: layer,
          layer,
          name: APP_LAYERS[layer].name,
          description: describe.get(layer),
          members: result.moves.filter((m) => m.layer === layer).map((m) => m.member),
        }));
        log(`layers placed — ${result.moves.length} correction(s) to the path heuristic`);
      }
    } catch (error) {
      stopIfCancelled();
      throw error;
    }
    stopIfCancelled();
    await publish();
  }

  // --- Placing what the grouping missed ----------------------------------------
  /** Keys of the features that gained files. */
  const grown = new Set<string>();
  let placed = 0;
  let unplaced = 0;
  if (level === "features" && !heuristicFallback) {
    let leftovers = uncoveredFiles(input.files, groups);
    if (leftovers.length > 0) {
      log(`${leftovers.length} file(s) in no feature — asking the model to place them: ${sample(leftovers)}`);
      progress.phase = "placing";
      progress.total = leftovers.length;
      await publish();
    } else if (mode === "place") {
      log("every file is already in a feature — nothing to place");
    }
    for (let round = 1; round <= MAX_PLACE_ROUNDS && leftovers.length > 0; round++) {
      stopIfCancelled();
      let placements: Map<string, string>;
      try {
        const result = await placeAppFiles(
          config,
          {
            repoName: repo.name,
            features: groups.map((g) => ({ name: g.name, description: g.description, members: g.members })),
            files: leftovers.map((f) => ({ path: f, declarations: declarations.get(f) ?? [] })),
          },
          { signal, tokenBudget: APP_MAP_TOKEN_BUDGET }
        );
        count(result.usage);
        placements = result.placements;
      } catch (error) {
        stopIfCancelled();
        // Placing is the whole point of a `place` run; in a full run the heuristic covers what's left.
        if (mode === "place") throw error;
        log(`placement call failed (continuing): ${(error as Error).message}`);
        break;
      }
      const keyOfName = new Map(groups.map((g) => [g.name, g.key]));
      const byKey = new Map<string, string>();
      for (const [file, name] of placements) {
        const key = keyOfName.get(name);
        if (key) byKey.set(file, key);
      }
      if (byKey.size === 0) {
        log(`placement round ${round}: the model placed none of the ${leftovers.length} file(s)`);
        break;
      }
      let members = 0;
      for (const [key, added] of compactPlacements(input.files, byKey)) {
        groups.find((g) => g.key === key)!.members.push(...added);
        grown.add(key);
        members += added.length;
      }
      placed += byKey.size;
      progress.done = placed;
      await publish();
      log(`placement round ${round}: placed ${byKey.size}/${leftovers.length} file(s) as ${members} new member(s)`);
      leftovers = uncoveredFiles(input.files, groups);
    }
    unplaced = leftovers.length;
    if (unplaced > 0) log(`${unplaced} file(s) still in no feature — the heuristic places them: ${sample(leftovers)}`);
    if (mode === "place" && unplaced > 0 && placed === 0) {
      throw new UnrecoverableError(`The model couldn't place any of the ${unplaced} file(s) — try again, or Redescribe to regroup.`);
    }
  }
  if (mode === "place" && grown.size === 0) {
    // Nothing was left over (a re-analysis covered it): the stored run stands as it is.
    return {
      repoId,
      level,
      mode,
      cards: 0,
      explained: 0,
      placed: 0,
      unplaced: 0,
      calls: progress.calls,
      promptTokens: progress.promptTokens,
      completionTokens: progress.completionTokens,
      parseFailed,
      durationMs: Date.now() - startedAt,
    };
  }

  // --- Assemble what the canvas will show -----------------------------------
  const draft: StoredAppMap = { level, groups, edges: [], model: config.model, createdAt: new Date().toISOString() };
  const architecture = level === "architecture" ? draft : (stored.get("architecture") ?? null);
  const layerOf = layerResolver(architecture);
  const resolved = groupsForLevel(input, level, level === "modules" ? null : draft, layerOf);
  const map = assembleAppMap(input, level, resolved.groups, layerOf);
  const keyOfNode = new Map(resolved.groups.map((g) => [cardId(level, g.key), g.key]));
  const nameOf = new Map(map.nodes.map((n) => [n.id, n.name]));

  // Only cards whose text is saved: heuristic cards for files still in no
  // feature are rebuilt on every read, so explaining them would be thrown
  // away. A `place` run re-explains just the features that grew.
  const savedKeys = new Set(groups.map((g) => g.key));
  const toExplain = map.nodes.filter((node) => {
    if (level === "modules") return true;
    const key = keyOfNode.get(node.id);
    return key !== undefined && savedKeys.has(key) && (mode === "full" || grown.has(key));
  });

  // --- Explaining -------------------------------------------------------------
  progress.phase = "explaining";
  progress.done = 0;
  progress.total = toExplain.length;
  await publish();

  const toExplainCard = (node: AppMapNodeDTO): AppExplainCard => ({
    name: node.name,
    description: node.description,
    layers: node.layers.map((l) => `${APP_LAYERS[l.layer].name} ${l.files}`).join(", "),
    modules: node.modules.map((m) => m.name),
    files: node.files.map((f) => ({ path: f, declarations: declarations.get(f) ?? [] })),
    outgoing: map.edges
      .filter((e) => e.source === node.id)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_OUTGOING_PER_CARD)
      .map((e) => ({ to: nameOf.get(e.target)!, weight: e.weight, samples: e.samples.map((s) => `${s.from} → ${s.to}`) })),
    incoming: map.edges
      .filter((e) => e.target === node.id)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_OUTGOING_PER_CARD)
      .map((e) => ({ from: nameOf.get(e.source)!, weight: e.weight })),
  });

  // Card names are unique per level in practice; if two collide the explain
  // normaliser simply attributes the answer to the first.
  const explanations = new Map<string, { description?: string; explanation?: string; keyFiles: Array<{ path: string; role: string }> }>();
  const edgeNotes: StoredAppMapEdge[] = [];
  const keyOfName = new Map(map.nodes.map((n) => [n.name.toLowerCase(), keyOfNode.get(n.id) ?? n.id]));
  const batch = EXPLAIN_BATCH[level];
  const cardKind = level === "architecture" ? "architectural layer" : level === "features" ? "feature of the app" : "module (folder of code)";
  for (let start = 0; start < toExplain.length; start += batch) {
    stopIfCancelled();
    const nodes = toExplain.slice(start, start + batch);
    try {
      const result = await explainAppCards(
        config,
        { repoName: repo.name, cardKind, cards: nodes.map(toExplainCard) },
        { signal }
      );
      count(result.usage);
      if (result.parseFailed) {
        parseFailed = true;
        log(`explain call for ${nodes.map((n) => n.name).join(", ")} was unusable`);
      }
      for (const card of result.cards) explanations.set(card.name.toLowerCase(), card);
      for (const edge of result.edges) {
        const from = keyOfName.get(edge.from.toLowerCase());
        const to = keyOfName.get(edge.to.toLowerCase());
        if (from && to) edgeNotes.push({ from, to, label: edge.label, explanation: edge.explanation });
      }
    } catch (error) {
      stopIfCancelled();
      parseFailed = true;
      log(`explain call failed (continuing): ${(error as Error).message}`);
    }
    progress.done = Math.min(toExplain.length, start + batch);
    await publish();
  }
  stopIfCancelled();

  // --- Saving -----------------------------------------------------------------
  progress.phase = "saving";
  await publish();

  const finalGroups: StoredAppMapGroup[] =
    level === "modules"
      ? map.nodes.map((node) => {
          const note = explanations.get(node.name.toLowerCase());
          return {
            key: keyOfNode.get(node.id)!,
            name: node.name,
            description: note?.description,
            explanation: note?.explanation,
            keyFiles: note?.keyFiles,
            members: [],
          };
        })
      : groups.map((group) => {
          const note = explanations.get(group.name.toLowerCase());
          // Unexplained groups keep what they have: nothing for a fresh
          // grouping, the stored text for a feature a `place` run left alone.
          if (!note) return group;
          return {
            ...group,
            // A layer's placement description is about membership; the
            // explain pass saw the files and connections, so it wins.
            description: note.description ?? group.description,
            explanation: note.explanation ?? group.explanation,
            keyFiles: note.keyFiles.length > 0 ? note.keyFiles : group.keyFiles,
          };
        });
  // A `place` run replaces the connection notes of the cards it re-explained and keeps the rest.
  const reexplained = new Set(groups.filter((g) => explanations.has(g.name.toLowerCase())).map((g) => g.key));
  const finalEdges =
    mode === "place" ? [...(previous?.edges ?? []).filter((e) => !reexplained.has(e.from)), ...edgeNotes] : edgeNotes;

  await saveAppMapRecord({
    repoId,
    level,
    groups: finalGroups,
    edges: finalEdges,
    model: config.model,
    createdAt: new Date().toISOString(),
  });
  await publish();

  const durationMs = Date.now() - startedAt;
  log(
    `done in ${durationMs}ms — ${map.nodes.length} card(s), ${explanations.size} explained, ${edgeNotes.length} edge note(s), ` +
      (level === "features" ? `${placed} file(s) placed, ${unplaced} left to the heuristic, ` : "") +
      `${progress.calls} call(s), ${progress.promptTokens}+${progress.completionTokens} token(s)`
  );
  return {
    repoId,
    level,
    mode,
    cards: map.nodes.length,
    explained: explanations.size,
    placed,
    unplaced,
    calls: progress.calls,
    promptTokens: progress.promptTokens,
    completionTokens: progress.completionTokens,
    parseFailed,
    durationMs,
  };
}
