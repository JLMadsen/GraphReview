// Getting before/after previews ready before anyone asks (DESIGN.md §6.9,
// "Ahead of time"). Everything a first preview would otherwise do while the
// user waits, done when it becomes likely that one is coming:
//
//   a target's scan finds changed components, or its before/after list or
//   dialog opens  →  runPreviewWarmJob: both checkouts, the tree volumes,
//                    the dependency installs and a warm session per side; with
//                    generous spending also the model's inputs for every file
//   a repo is analysed  →  prewarmRepoDeps: the analysed commit's dependencies,
//                    which most pull requests share (only for repos someone
//                    has previewed, or under generous spending)
//
// A warm-up also loads each changed file once without rendering it, so the
// packages it imports are in the session's module cache when Run is pressed.
//
// All best effort and quiet: nothing here fails a preview or an analysis,
// and none of it runs without Docker. `PREVIEW_PREWARM=0` turns it off.
//
// Kept out of lib/jobs' barrel: it pulls in lib/ai and lib/analysis.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getRepoById } from "@/lib/db";
import { materializeTree, projectRootFor, readFileAt } from "@/lib/preview/checkout";
import { DEFAULT_NODE_MAJOR, requiredNodeMajor } from "@/lib/preview/node-version";
import {
  getDockerStatus,
  nodeImageFor,
  prepareDeps,
  prepareTreeVolume,
  releaseTreeVolume,
  resolveImage,
  runInSession,
  sessionsEnabled,
  startSession,
} from "@/lib/preview/sandbox";
import { detectChangedSymbols } from "@/lib/preview/symbols";
import type { PreviewScanResult } from "@/lib/preview/types";
import type { JobLogger } from "./analyze";
import { isGenerousSpending } from "./ai-config";
import { recordAndPruneVolumes, resolveCommits, resolvePreviewInputs, wantedImageFor, wasRepoPreviewed } from "./preview";
import { ensurePreviewScan, type PreviewWarmJobData } from "./preview-queue";
import { repoCacheDir, validateLocalRepoPath } from "./source";

const PREWARM_ON = process.env.PREVIEW_PREWARM?.trim() !== "0";

/** Sessions per side a warm-up starts at most: one per project folder the changed components live in. */
const MAX_PROJECTS = 2;
/** Changed files per project and side a warm-up loads ahead (bundled and imported, nothing rendered). */
const MAX_PRELOADED_FILES = 10;
/** Model calls a generous warm-up makes at once. */
const INPUT_CONCURRENCY = 3;
/** How long a warm-up opened from the UI waits for the target's scan. */
const SCAN_WAIT_MS = 2 * 60_000;

async function dockerUp(): Promise<boolean> {
  return PREWARM_ON && (await getDockerStatus().catch(() => ({ available: false }))).available;
}

/** The target's scan, waited for when it is still running (a warm-up opened from the UI can beat it). */
async function scanOf(data: PreviewWarmJobData): Promise<PreviewScanResult | null> {
  const deadline = Date.now() + SCAN_WAIT_MS;
  for (;;) {
    const job = await ensurePreviewScan(data.repoId, data.target);
    const state = await job.getState();
    if (state === "completed") return job.returnvalue ?? null;
    if (state === "failed" || Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

/** Runs `work` over `items`, `limit` at a time. */
async function inBatches<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    })
  );
}

/**
 * Gets a target's previews ready: for each project folder its changed
 * components live in (at most {@link MAX_PROJECTS}), both sides' checkout,
 * tree volume, dependencies and warm session — the same ones a preview of
 * any of those files then finds. Under generous spending, also the model's
 * inputs for every scanned file, so Preview all starts rendering at once.
 */
export async function runPreviewWarmJob(data: PreviewWarmJobData, log: JobLogger): Promise<void> {
  if (!(await dockerUp())) return;
  const repo = await getRepoById(data.repoId);
  if (!repo) return;
  const scan = await scanOf(data);
  if (!scan || scan.files.length === 0) return;
  const started = Date.now();
  const { repoDir, baseSha, headSha } = await resolveCommits(repo, data.target, log);
  const generous = await isGenerousSpending();

  // The model's inputs don't need Docker's work, so they go alongside it.
  const inputs = generous ? prefetchInputs(data.repoId, repoDir, baseSha, headSha, scan, log) : Promise.resolve();

  const scratch = await mkdtemp(path.join(os.tmpdir(), "graphreview-preview-warm-"));
  const held: Array<string | undefined> = [];
  const deps: Array<string | undefined> = [];
  try {
    if (sessionsEnabled("node")) {
      // One image per project folder: the one a preview of its first changed file picks.
      const projects = new Map<string, string>();
      const sides = [
        { sha: baseSha, dir: path.join(scratch, "before") },
        { sha: headSha, dir: path.join(scratch, "after") },
      ];
      await Promise.all(sides.map((side) => materializeTree(repoDir, side.sha, side.dir, scratch)));
      for (const file of scan.files) {
        const root = projectRootFor(sides[1].dir, file.filePath, "node");
        if (!projects.has(root) && projects.size < MAX_PROJECTS) {
          projects.set(root, (await resolveImage(await wantedImageFor(repoDir, baseSha, headSha, file.filePath, "node", () => undefined), log)).image);
        }
      }
      await Promise.all(
        sides.flatMap((side) =>
          [...projects].map(async ([projectRoot, image]) => {
            const [installed, treeVolume] = await Promise.all([
              prepareDeps("node", side.dir, projectRoot, log, image),
              prepareTreeVolume(side.sha, side.dir, image, log),
            ]);
            held.push(treeVolume);
            deps.push(installed.volume);
            const session = { image, sha: side.sha, treeVolume, treeDir: side.dir, projectRoot, deps: installed };
            await startSession(session);
            // Each changed file loaded once without rendering (no cases): the packages it imports are then
            // in the worker's module cache, which is most of a first file's time.
            const files = scan.files.filter((f) => projectRootFor(side.dir, f.filePath, "node") === projectRoot).slice(0, MAX_PRELOADED_FILES);
            for (const file of files) {
              const symbols = file.components.map((c) => ({ name: c.name, kind: "component", cases: [] }));
              await runInSession(session, { side: "after", file: file.filePath, projectRoot, caseTimeoutMs: 10_000, symbols, mocks: {} }, {}).catch(
                () => undefined
              );
            }
          })
        )
      );
    }
    await inputs;
    log(`previews ready ahead of time for ${scan.files.length} file(s) in ${Date.now() - started} ms${generous ? ", inputs included" : ""}`);
  } finally {
    await inputs.catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    for (const volume of held) releaseTreeVolume(volume);
    await recordAndPruneVolumes(deps, held, log);
  }
}

/** Generous spending: the model's inputs for every scanned file, into the cache the preview job reads first. */
async function prefetchInputs(
  repoId: string,
  repoDir: string,
  baseSha: string,
  headSha: string,
  scan: PreviewScanResult,
  log: JobLogger
): Promise<void> {
  await inBatches(scan.files, INPUT_CONCURRENCY, async ({ filePath }) => {
    try {
      const [before, after] = await Promise.all([readFileAt(repoDir, baseSha, filePath), readFileAt(repoDir, headSha, filePath)]);
      const detected = await detectChangedSymbols(filePath, "node", before, after);
      if (detected.runnable.length === 0) return;
      await resolvePreviewInputs({ repoId, filePath, runtime: "node", symbols: detected.runnable, detected, before, after, log });
    } catch (error) {
      log(`inputs for ${filePath} skipped: ${(error as Error).message}`);
    }
  });
}

/**
 * After an analysis: installs the analysed commit's dependencies (repo root),
 * so the first preview of a pull request that doesn't touch the lockfile
 * finds them ready. Only for repos someone has previewed, or under generous
 * spending — an install is hundreds of MB and minutes of network.
 */
export async function prewarmRepoDeps(repoId: string, sha: string, log: JobLogger): Promise<void> {
  try {
    if (!(wasRepoPreviewed(repoId) || (await isGenerousSpending()))) return;
    if (!(await dockerUp())) return;
    const repo = await getRepoById(repoId);
    if (!repo) return;
    const repoDir = repo.provider === "local" ? (repo.localPath ? await validateLocalRepoPath(repo.localPath) : null) : repoCacheDir(repoId);
    if (!repoDir || (await readFileAt(repoDir, sha, "package.json")) === null) return;
    const major = await requiredNodeMajor((p) => readFileAt(repoDir, sha, p), "package.json");
    const { image } = await resolveImage(nodeImageFor(major ?? DEFAULT_NODE_MAJOR), log);
    const scratch = await mkdtemp(path.join(os.tmpdir(), "graphreview-preview-deps-"));
    try {
      const treeDir = path.join(scratch, "tree");
      await materializeTree(repoDir, sha, treeDir, scratch);
      const installed = await prepareDeps("node", treeDir, ".", log, image);
      log(`preview dependencies for ${sha.slice(0, 7)}: ${installed.status}`);
      await recordAndPruneVolumes([installed.volume], [], log);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    log(`preview dependencies skipped: ${(error as Error).message}`);
  }
}
