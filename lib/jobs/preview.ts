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

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnrecoverableError } from "bullmq";
import { generatePreviewInputs, type AiProviderConfig } from "@/lib/ai";
import { decrypt } from "@/lib/crypto";
import { getActiveAiProvider, getRepoById, type RepoRecord } from "@/lib/neo4j";
import { materializeTree, mergeBaseOf, projectRootFor, readFileAt, runtimeForPath } from "@/lib/preview/checkout";
import {
  assertDockerAvailable,
  harnessScript,
  prepareDeps,
  pruneDepsVolumes,
  runHarness,
  SandboxUnavailableError,
} from "@/lib/preview/sandbox";
import { detectChangedSymbols } from "@/lib/preview/symbols";
import type {
  PreviewCaseInput,
  PreviewCaseOutcome,
  PreviewHarnessResult,
  PreviewInputs,
  PreviewProgress,
  PreviewResult,
  PreviewRuntime,
  PreviewSide,
  PreviewSideSummary,
  PreviewSymbol,
  PreviewSymbolResult,
} from "@/lib/preview/types";
import type { JobLogger } from "./analyze";
import { loadPrContext } from "./pr-context";
import type { PreviewJobData } from "./preview-queue";
import type { ReviewTarget } from "./review-queue";
import { getRedisConnection } from "./queue";
import { ensureCommitsInCache, validateLocalRepoPath } from "./source";

/** Redis hash: dependency cache volume → when a preview last used it (ms). Survives worker restarts, unlike memory. */
const DEPS_LAST_USED_KEY = "graphreview:preview:deps-last-used";

/**
 * Records which dependency caches this run used, then removes the ones that
 * went unused for too long (lib/preview/sandbox.ts `pruneDepsVolumes`).
 * Best effort: cleanup never fails a preview.
 */
async function recordAndPruneDeps(used: Array<string | undefined>, log: JobLogger): Promise<void> {
  try {
    const redis = getRedisConnection();
    const now = String(Date.now());
    for (const volume of new Set(used.filter((v): v is string => Boolean(v)))) {
      await redis.hset(DEPS_LAST_USED_KEY, volume, now);
    }
    const stored = await redis.hgetall(DEPS_LAST_USED_KEY);
    const lastUsed = new Map(Object.entries(stored).map(([k, v]) => [k, Number(v)] as const));
    const removed = await pruneDepsVolumes(lastUsed, log);
    if (removed.length > 0) await redis.hdel(DEPS_LAST_USED_KEY, ...removed);
  } catch (error) {
    log(`dependency cache cleanup skipped: ${(error as Error).message}`);
  }
}

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

function sameOutcome(a: PreviewCaseOutcome | undefined, b: PreviewCaseOutcome | undefined): boolean {
  if (!a || !b) return false;
  return a.returned === b.returned && a.argsAfter === b.argsAfter && a.html === b.html && a.threw === b.threw;
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

interface SideRun {
  harness: PreviewHarnessResult | null;
  deps: string;
  /** The dependency cache volume this side ran with, if any. */
  depsVolume?: string;
  fatal?: string;
}

async function runSide(options: {
  side: PreviewSide;
  runtime: PreviewRuntime;
  repoDir: string;
  sha: string;
  filePath: string;
  symbols: PreviewSymbol[];
  inputs: PreviewInputs;
  scratch: string;
  log: JobLogger;
}): Promise<SideRun> {
  const { side, runtime, repoDir, sha, filePath, symbols, inputs, scratch } = options;
  const log: JobLogger = (message) => options.log(`${side}: ${message}`);
  const treeDir = path.join(scratch, side);
  const jobDir = path.join(scratch, `${side}-job`);
  let deps = "none";
  let depsVolume: string | undefined;
  try {
    log(`writing the tree at ${sha.slice(0, 7)}`);
    await materializeTree(repoDir, sha, treeDir, scratch);
    const projectRoot = projectRootFor(treeDir, filePath, runtime);
    const prepared = await prepareDeps(runtime, treeDir, projectRoot, log);
    deps = prepared.status;
    depsVolume = prepared.volume;

    await mkdir(jobDir, { recursive: true });
    const script = harnessScript(runtime);
    await copyFile(script, path.join(jobDir, path.basename(script)));
    const spec = {
      side,
      file: filePath,
      projectRoot,
      caseTimeoutMs: CASE_TIMEOUT_MS,
      symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, cases: inputs[s.name] ?? [] })),
    };
    await writeFile(path.join(jobDir, "spec.json"), JSON.stringify(spec));
    log("running in the sandbox");
    const harness = await runHarness({ runtime, treeDir, jobDir, projectRoot, deps: prepared, log });
    return { harness, deps, depsVolume };
  } catch (error) {
    if (error instanceof SandboxUnavailableError) throw error;
    log(`failed: ${(error as Error).message}`);
    return { harness: null, deps, depsVolume, fatal: (error as Error).message };
  }
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
  const detected = await detectChangedSymbols(data.filePath, runtime, before, after);
  const symbols = detected.runnable;
  log(`${symbols.length} changed function(s)/component(s), ${detected.skipped.length} skipped`);

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

  // 4 + 5. prepare and run both sides
  const scratch = await mkdtemp(path.join(os.tmpdir(), "graphreview-preview-"));
  let beforeRun: SideRun = { harness: null, deps: "none" };
  let afterRun: SideRun = { harness: null, deps: "none" };
  try {
    if (symbols.length > 0) {
      progress("preparing", "checking out both sides and running them in the sandbox");
      const common = { runtime, repoDir, filePath: data.filePath, inputs, scratch, log };
      [beforeRun, afterRun] = await Promise.all([
        before === null
          ? Promise.resolve<SideRun>({ harness: null, deps: "none" })
          : runSide({ ...common, side: "before", sha: baseSha, symbols: symbols.filter((s) => s.change !== "added") }),
        after === null
          ? Promise.resolve<SideRun>({ harness: null, deps: "none" })
          : runSide({ ...common, side: "after", sha: headSha, symbols: symbols.filter((s) => s.change !== "removed") }),
      ]);
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
        differs: !sameOutcome(beforeCase, afterCase),
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
    durationMs: Date.now() - started,
  };
}
