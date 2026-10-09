// The before/after preview job (DESIGN.md §6.9): run the functions and
// components one file of a PR changed, at the PR's base and at its head, on
// the same mocked-up inputs, and line the results up.
//
//   1. resolve   pin the target to two commits (base = merge-base, like the diff)
//   2. detect    which declarations changed (lib/preview/symbols.ts)
//   3. inputs    the user's edited inputs, else the AI's, else empty defaults
//   4. prepare   write each side's whole tree, install dependencies (cached)
//   5. run       one offline container per side (lib/preview/sandbox.ts)
//   6. compare   case by case: return value, arguments after, markup, error
//
// Kept out of lib/jobs' barrel: it pulls in lib/ai and lib/analysis.

import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnrecoverableError } from "./runner";
import { generatePreviewInputs, generatePreviewMocks, type AiProviderConfig } from "@/lib/ai";
import { decrypt } from "@/lib/crypto";
import { getActiveAiProvider, getRepoById, type RepoRecord } from "@/lib/db";
import { materializeTree, mergeBaseOf, projectRootFor, readFileAt, runtimeForPath } from "@/lib/preview/checkout";
import {
  assertDockerAvailable,
  harnessScript,
  imageFor,
  nodeImageFor,
  resolveImage,
  type ResolvedImage,
  prepareDeps,
  pruneDepsVolumes,
  runHarness,
  SandboxUnavailableError,
  type PreparedDeps,
} from "@/lib/preview/sandbox";
import { relatedSources } from "@/lib/preview/related";
import { detectChangedSymbols } from "@/lib/preview/symbols";
import { DEFAULT_NODE_MAJOR, requiredNodeMajor } from "@/lib/preview/node-version";
import { caseDiffers } from "@/lib/preview/compare";
import type {
  PreviewCaseInput,
  PreviewHarnessResult,
  PreviewInputs,
  PreviewMocks,
  PreviewProgress,
  PreviewResult,
  PreviewRuntime,
  PreviewServerCall,
  PreviewSide,
  PreviewSideSummary,
  PreviewSymbol,
  PreviewSymbolResult,
} from "@/lib/preview/types";
import type { JobLogger } from "./analyze";
import { readKv, writeKv } from "@/lib/db";
import { loadPrContext } from "./pr-context";
import type { PreviewJobData } from "./preview-queue";
import type { ReviewTarget } from "./review-queue";
import { ensureCommitsInCache, validateLocalRepoPath } from "./source";

/** Dependency cache volume → when a preview last used it (ms). Survives restarts, unlike memory. */
const DEPS_LAST_USED_KEY = "preview:deps-last-used";

/**
 * Per repo: server call key → mocked JSON response. A repo's files mostly
 * call the same things (every page checks the session), so a mock made for
 * one file is reused by every later preview in the repo instead of asking
 * the model again. The cache expires after 30 days without a write.
 */
function mockCacheKey(repoId: string): string {
  return `preview:mocks:${repoId}`;
}
const MOCK_CACHE_TTL_S = 30 * 24 * 60 * 60;

async function readMockCache(repoId: string): Promise<PreviewMocks> {
  try {
    return readKv<PreviewMocks>(mockCacheKey(repoId)) ?? {};
  } catch {
    return {};
  }
}

async function writeMockCache(repoId: string, mocks: PreviewMocks): Promise<void> {
  if (Object.keys(mocks).length === 0) return;
  try {
    writeKv(mockCacheKey(repoId), { ...(await readMockCache(repoId)), ...mocks }, MOCK_CACHE_TTL_S);
  } catch {
    /* the cache is an optimisation */
  }
}

/** A provider refusing for quota/rate reasons, as opposed to a broken request. */
function isQuotaError(error: unknown): boolean {
  return /\b(429|quota|rate.?limit|resource.?exhausted|too many requests)\b/i.test(String((error as Error)?.message ?? error));
}

/**
 * Records which dependency caches this run used, then removes the ones that
 * went unused for too long (lib/preview/sandbox.ts `pruneDepsVolumes`).
 * Best effort: cleanup never fails a preview.
 */
async function recordAndPruneDeps(used: Array<string | undefined>, log: JobLogger): Promise<void> {
  try {
    const lastUsed = new Map(Object.entries(readKv<Record<string, number>>(DEPS_LAST_USED_KEY) ?? {}));
    const now = Date.now();
    for (const volume of new Set(used.filter((v): v is string => Boolean(v)))) lastUsed.set(volume, now);
    const removed = await pruneDepsVolumes(lastUsed, log);
    for (const volume of removed) lastUsed.delete(volume);
    writeKv(DEPS_LAST_USED_KEY, Object.fromEntries(lastUsed));
  } catch (error) {
    log(`dependency cache cleanup skipped: ${(error as Error).message}`);
  }
}

/** Record → mock → replay rounds: each can reveal calls the previous one gated (a session check, then the page's data). */
const MAX_MOCK_ROUNDS = 3;

/** Per case, inside the container. Whole-container limits live in sandbox.ts. */
const CASE_TIMEOUT_MS = 10_000;

interface ProgressSink {
  updateProgress(progress: PreviewProgress): Promise<void>;
}

async function loadAiConfig(): Promise<AiProviderConfig | null> {
  try {
    const provider = await getActiveAiProvider();
    if (!provider?.baseUrl || !provider?.apiKeyEncrypted || !provider?.model) return null;
    return { baseUrl: provider.baseUrl, apiKey: decrypt(provider.apiKeyEncrypted as string), model: provider.model };
  } catch {
    return null;
  }
}

function defaultCases(symbol: PreviewSymbol): PreviewCaseInput[] {
  return symbol.kind === "component"
    ? [{ label: "no props", input: { props: {} } }]
    : [{ label: "no arguments", input: { args: [] } }];
}

/** The fallback refs to fetch when a host won't serve a commit by sha. */
function fallbackRefspecs(repo: RepoRecord, target: ReviewTarget): string[] {
  if (target.kind === "refs") return [target.baseRef, target.headRef];
  return repo.provider === "gitlab" ? [`merge-requests/${target.prNumber}/head`] : [`pull/${target.prNumber}/head`];
}

/** Pins a target to its merge-base and head and makes both available on disk. Also used by ./preview-scan.ts. */
export async function resolveCommits(
  repo: RepoRecord,
  target: ReviewTarget,
  log: JobLogger
): Promise<{ repoDir: string; baseSha: string; headSha: string; changedFiles: string[] }> {
  const context = await loadPrContext(repo, target, log);
  const changedFiles = context.files.map((f) => f.path);
  const { baseSha, headSha } = context.reviewed;
  if (!baseSha || !headSha) throw new UnrecoverableError("The base and head commits of this target could not be resolved.");

  let repoDir: string;
  if (repo.provider === "local") {
    if (!repo.localPath) throw new UnrecoverableError("This local repo has no path on record.");
    repoDir = await validateLocalRepoPath(repo.localPath);
  } else {
    repoDir = await ensureCommitsInCache(repo, [baseSha, headSha], fallbackRefspecs(repo, target), log);
  }
  // Compare against where the branch left off, exactly like the three-dot diff does.
  return { repoDir, baseSha: await mergeBaseOf(repoDir, baseSha, headSha), headSha, changedFiles };
}

function summarize(
  sha: string,
  harness: PreviewHarnessResult | null,
  deps: string,
  missing: boolean,
  fatal?: string
): PreviewSideSummary {
  return {
    sha,
    ...(missing ? { missing: true } : {}),
    ...(fatal ?? harness?.fatal ? { fatal: fatal ?? harness?.fatal } : {}),
    stubbedModules: harness?.stubbedModules ?? [],
    warnings: harness?.warnings ?? [],
    ...(harness?.css ? { css: harness.css } : {}),
    ...(harness?.cssNote ? { cssNote: harness.cssNote } : {}),
    deps,
  };
}

/** A side's checkout and dependencies, kept so the side can run again (with mocks) without redoing them. */
interface PreparedSide {
  treeDir: string;
  jobDir: string;
  projectRoot: string;
  prepared: PreparedDeps;
}

interface SideRun {
  harness: PreviewHarnessResult | null;
  deps: string;
  /** The dependency cache volume this side ran with, if any. */
  depsVolume?: string;
  fatal?: string;
  prepared?: PreparedSide;
}

const NO_SIDE: SideRun = { harness: null, deps: "none" };

async function runSide(options: {
  side: PreviewSide;
  runtime: PreviewRuntime;
  /** The sandbox image (both sides share one); undefined = the runtime's default. */
  image?: string;
  repoDir: string;
  sha: string;
  filePath: string;
  symbols: PreviewSymbol[];
  inputs: PreviewInputs;
  mocks: PreviewMocks;
  scratch: string;
  log: JobLogger;
  /** Reuse an earlier run's checkout and dependencies. */
  reuse?: PreparedSide;
}): Promise<SideRun> {
  const { side, runtime, image, repoDir, sha, filePath, symbols, inputs, mocks, scratch, reuse } = options;
  const log: JobLogger = (message) => options.log(`${side}: ${message}`);
  let deps = reuse?.prepared.status ?? "none";
  let depsVolume = reuse?.prepared.volume;
  try {
    let prepared = reuse;
    if (!prepared) {
      const treeDir = path.join(scratch, side);
      const jobDir = path.join(scratch, `${side}-job`);
      log(`writing the tree at ${sha.slice(0, 7)}`);
      await materializeTree(repoDir, sha, treeDir, scratch);
      const projectRoot = projectRootFor(treeDir, filePath, runtime);
      const installed = await prepareDeps(runtime, treeDir, projectRoot, log, image);
      deps = installed.status;
      depsVolume = installed.volume;
      await mkdir(jobDir, { recursive: true });
      const script = harnessScript(runtime);
      await copyFile(script, path.join(jobDir, path.basename(script)));
      // The Node harness loads its stand-in values from a file beside it.
      if (runtime === "node") await copyFile(path.join(path.dirname(script), "preview-fakes.mjs"), path.join(jobDir, "preview-fakes.mjs"));
      prepared = { treeDir, jobDir, projectRoot, prepared: installed };
    }
    const spec = {
      side,
      file: filePath,
      projectRoot: prepared.projectRoot,
      caseTimeoutMs: CASE_TIMEOUT_MS,
      symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, cases: inputs[s.name] ?? [] })),
      mocks,
    };
    await writeFile(path.join(prepared.jobDir, "spec.json"), JSON.stringify(spec));
    log(Object.keys(mocks).length > 0 ? `running in the sandbox with ${Object.keys(mocks).length} mocked server response(s)` : "running in the sandbox");
    const harness = await runHarness({
      runtime,
      treeDir: prepared.treeDir,
      jobDir: prepared.jobDir,
      projectRoot: prepared.projectRoot,
      deps: prepared.prepared,
      log,
      image,
    });
    return { harness, deps, depsVolume, prepared };
  } catch (error) {
    if (error instanceof SandboxUnavailableError) throw error;
    log(`failed: ${(error as Error).message}`);
    return { harness: null, deps, depsVolume, fatal: (error as Error).message, prepared: reuse };
  }
}

/** Server calls from both sides, merged by key (counts added, "mocked" if either side had a mock). */
function mergeCalls(...runs: SideRun[]): PreviewServerCall[] {
  const merged = new Map<string, PreviewServerCall>();
  for (const run of runs) {
    for (const call of run.harness?.serverCalls ?? []) {
      const existing = merged.get(call.key);
      if (existing) {
        existing.count += call.count;
        existing.mocked ||= call.mocked;
      } else merged.set(call.key, { ...call });
    }
  }
  return [...merged.values()];
}

/** The source of the module defining a server action, read from whichever side has it. */
async function actionSource(call: PreviewServerCall, sides: SideRun[]): Promise<string | undefined> {
  if (!call.module) return undefined;
  for (const side of sides) {
    if (!side.prepared) continue;
    const text = await readFile(path.join(side.prepared.treeDir, call.module), "utf8").catch(() => null);
    if (text) return text;
  }
  return undefined;
}

export async function runPreviewJob(
  data: PreviewJobData,
  job: ProgressSink,
  log: JobLogger
): Promise<PreviewResult> {
  const started = Date.now();
  const progress = (stage: PreviewProgress["stage"], message: string) => {
    log(message);
    void job.updateProgress({ stage, message }).catch(() => undefined);
  };

  const repo = await getRepoById(data.repoId);
  if (!repo) throw new UnrecoverableError(`Repo ${data.repoId} not found.`);
  const runtime = runtimeForPath(data.filePath);
  if (!runtime) {
    throw new UnrecoverableError("Previews run JavaScript/TypeScript and Python files only.");
  }
  try {
    await assertDockerAvailable();
  } catch (error) {
    throw new UnrecoverableError((error as Error).message);
  }

  // 1. resolve
  progress("resolving", "resolving the base and head commits");
  const { repoDir, baseSha, headSha } = await resolveCommits(repo, data.target, log);

  // 2. detect
  const [before, after] = await Promise.all([
    readFileAt(repoDir, baseSha, data.filePath),
    readFileAt(repoDir, headSha, data.filePath),
  ]);
  if (before === null && after === null) {
    throw new UnrecoverableError(`${data.filePath} exists at neither ${baseSha.slice(0, 7)} nor ${headSha.slice(0, 7)}.`);
  }
  // Both sides run on one image — the newer Node either side asks for — so
  // a difference in output is the code's, not the runtime's.
  let wantedImage = imageFor(runtime);
  if (runtime === "node") {
    const majors = await Promise.all(
      [baseSha, headSha].map((sha) => requiredNodeMajor((p) => readFileAt(repoDir, sha, p), data.filePath))
    );
    const declared = majors.filter((m): m is number => m !== undefined);
    wantedImage = nodeImageFor(declared.length > 0 ? Math.max(...declared) : DEFAULT_NODE_MAJOR);
    log(`sandbox image ${wantedImage}${declared.length > 0 ? "" : " (the repo doesn't say which Node it needs)"}`);
  }

  const detected = await detectChangedSymbols(data.filePath, runtime, before, after);
  const symbols = detected.runnable;
  log(`${symbols.length} changed function(s)/component(s), ${detected.skipped.length} skipped`);

  // Offline or on a mirror without it, the closest image on this machine stands in (noted in the result).
  const resolvedImage: ResolvedImage = symbols.length > 0 ? await resolveImage(wantedImage, log) : { image: wantedImage };
  const image = resolvedImage.image;

  // 3. inputs
  const inputs: PreviewInputs = {};
  let inputsSource: PreviewResult["inputsSource"] = "default";
  let inputsNote: string | undefined;
  const needInputs: PreviewSymbol[] = [];
  for (const symbol of symbols) {
    const given = data.inputs?.[symbol.name];
    if (given && given.length > 0) {
      inputs[symbol.name] = given;
      inputsSource = "user";
    } else {
      needInputs.push(symbol);
    }
  }
  if (needInputs.length > 0) {
    progress("inputs", `mocking up inputs for ${needInputs.map((s) => s.name).join(", ")}`);
    const config = await loadAiConfig();
    if (!config) {
      inputsNote = "No AI provider is configured, so each symbol starts with empty inputs. Edit them and run again.";
    } else {
      try {
        const result = await generatePreviewInputs(config, {
          filePath: data.filePath,
          language: runtime === "python" ? "python" : "javascript/typescript",
          symbols: needInputs.map((s) => ({
            name: s.name,
            kind: s.kind,
            change: s.change,
            via: s.via,
            before: detected.sources[s.name]?.before,
            after: detected.sources[s.name]?.after,
          })),
          fileAfter: after ?? undefined,
          fileBefore: before ?? undefined,
        });
        for (const [name, cases] of Object.entries(result.inputs)) inputs[name] = cases;
        if (inputsSource === "default" && Object.keys(result.inputs).length > 0) inputsSource = "ai";
        if (result.parseFailed) {
          inputsNote = "The AI's answer couldn't be read, even after asking again, so empty inputs were used. Edit them and run again.";
          log(`unreadable AI answer: ${(result.rawAnswer ?? "").replace(/\s+/g, " ")}`);
        }
        log(`inputs from the AI: ${result.usage.promptTokens}+${result.usage.completionTokens} tokens`);
      } catch (error) {
        inputsNote = `Mocking up inputs failed (${(error as Error).message}), so empty inputs were used.`;
        log(inputsNote);
      }
    }
    for (const symbol of needInputs) inputs[symbol.name] ??= defaultCases(symbol);
  }

  // 4 + 5. prepare and run both sides; then record → mock → replay: server
  // calls the renders made (server actions, fetch) get mocked answers from the
  // model, and both sides run again with them.
  const scratch = await mkdtemp(path.join(os.tmpdir(), "graphreview-preview-"));
  let beforeRun: SideRun = NO_SIDE;
  let afterRun: SideRun = NO_SIDE;
  // The repo's cached mocks first, then whatever this run was given (edited or reused) on top.
  let mocks: PreviewMocks = { ...(await readMockCache(data.repoId)), ...(data.mocks ?? {}) };
  let mocksSource: PreviewResult["mocksSource"] = data.mocks && Object.keys(data.mocks).length > 0 ? "user" : "none";
  let mocksNote: string | undefined;
  try {
    if (symbols.length > 0) {
      progress("preparing", "checking out both sides and running them in the sandbox");
      const runBoth = (reuseBefore?: PreparedSide, reuseAfter?: PreparedSide) => {
        const common = { runtime, image, repoDir, filePath: data.filePath, inputs, mocks, scratch, log };
        return Promise.all([
          before === null
            ? Promise.resolve<SideRun>(NO_SIDE)
            : runSide({ ...common, side: "before", sha: baseSha, symbols: symbols.filter((s) => s.change !== "added"), reuse: reuseBefore }),
          after === null
            ? Promise.resolve<SideRun>(NO_SIDE)
            : runSide({ ...common, side: "after", sha: headSha, symbols: symbols.filter((s) => s.change !== "removed"), reuse: reuseAfter }),
        ]);
      };
      [beforeRun, afterRun] = await runBoth();

      // Each round can reveal more calls: once a session check passes, the page loads its data.
      for (let round = 1; round <= MAX_MOCK_ROUNDS; round++) {
        const unmocked = mergeCalls(beforeRun, afterRun).filter((c) => !(c.key in mocks));
        if (unmocked.length === 0) break;
        const config = await loadAiConfig();
        if (!config) {
          mocksNote = `${unmocked.length} server call(s) had no answer (no AI provider configured to mock them).`;
          break;
        }
        progress("inputs", `mocking ${unmocked.length} server response(s): ${unmocked.slice(0, 4).map((c) => c.name ?? c.key).join(", ")}`);
        try {
          const sides = [afterRun, beforeRun];
          const treeDir = (afterRun.prepared ?? beforeRun.prepared)?.treeDir;
          const actionModules = [...new Set(unmocked.map((c) => c.module).filter((m): m is string => Boolean(m)))];
          const callerSources = treeDir ? await relatedSources(treeDir, actionModules, [data.filePath], [data.filePath]).catch(() => []) : [];
          const result = await generatePreviewMocks(config, {
            filePath: data.filePath,
            fileSource: after ?? before ?? undefined,
            callerSources,
            calls: await Promise.all(
              unmocked.map(async (c) => ({
                key: c.key,
                kind: c.kind,
                args: c.args,
                url: c.url,
                method: c.method,
                body: c.body,
                source: c.kind === "action" ? await actionSource(c, sides) : undefined,
              }))
            ),
          });
          log(
            `server mocks (round ${round}): ${Object.keys(result.mocks).length} of ${unmocked.length}, with ${callerSources.length} related file(s), ` +
              `${result.usage.promptTokens}+${result.usage.completionTokens} tokens`
          );
          if (result.parseFailed) log(`unreadable AI answer (mocks): ${(result.rawAnswer ?? "").replace(/\s+/g, " ")}`);
          if (Object.keys(result.mocks).length === 0) break;
          mocks = { ...mocks, ...result.mocks };
          await writeMockCache(data.repoId, result.mocks);
          if (mocksSource === "none") mocksSource = "ai";
          progress("running", "rendering again with the mocked server responses");
          [beforeRun, afterRun] = await runBoth(beforeRun.prepared, afterRun.prepared);
        } catch (error) {
          mocksNote = isQuotaError(error)
            ? "The AI provider refused (quota or rate limit), so some server calls had no mocked answer and those parts render as if the server were down. Try again later."
            : `Mocking the server responses failed (${(error as Error).message}).`;
          log(mocksNote);
          break;
        }
      }
    }
  } catch (error) {
    if (error instanceof SandboxUnavailableError) throw new UnrecoverableError(error.message);
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    await recordAndPruneDeps([beforeRun.depsVolume, afterRun.depsVolume], log);
  }

  // 6. compare
  const results: PreviewSymbolResult[] = symbols.map((symbol) => {
    const b = beforeRun.harness?.symbols.find((s) => s.name === symbol.name);
    const a = afterRun.harness?.symbols.find((s) => s.name === symbol.name);
    const cases = (inputs[symbol.name] ?? []).map((c, index) => {
      const beforeCase = b?.cases?.[index];
      const afterCase = a?.cases?.[index];
      return {
        label: c.label,
        input: c.input,
        ...(beforeCase ? { before: beforeCase } : {}),
        ...(afterCase ? { after: afterCase } : {}),
        differs: caseDiffers(symbol, { before: beforeCase, after: afterCase }),
      };
    });
    return {
      ...symbol,
      cases,
      ...(b?.error ? { beforeError: b.error } : {}),
      ...(a?.error ? { afterError: a.error } : {}),
    };
  });

  return {
    filePath: data.filePath,
    runtime,
    baseSha,
    headSha,
    symbols: results,
    skipped: detected.skipped,
    before: summarize(baseSha, beforeRun.harness, beforeRun.deps, before === null, beforeRun.fatal),
    after: summarize(headSha, afterRun.harness, afterRun.deps, after === null, afterRun.fatal),
    inputsSource,
    inputs,
    ...(inputsNote ? { inputsNote } : {}),
    ...(resolvedImage.note ? { runtimeNote: resolvedImage.note } : {}),
    mocks,
    // Mocks reused from the repo cache were made by the model too.
    mocksSource: mocksSource === "none" && mergeCalls(beforeRun, afterRun).some((c) => c.mocked) ? "ai" : mocksSource,
    serverCalls: mergeCalls(beforeRun, afterRun),
    ...(mocksNote ? { mocksNote } : {}),
    durationMs: Date.now() - started,
  };
}
