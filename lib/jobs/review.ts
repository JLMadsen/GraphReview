// The AI review job body.
//
// Pipeline: load the repo → load and decrypt the AI provider settings →
// fetch the diff and the "intent" context for the target → map changed
// files onto the component graph → one LLM call per touched component,
// a few in flight at a time → persist each component's findings the
// moment it completes (overwriting any previous run's findings for that
// component, but keeping the triage of findings it says again), so they
// stream into the UI → prune findings for components
// the target no longer touches → the impact pass (usages of changed
// signatures/types the PR left behind, ./impact.ts) → for a PR, the one
// "does it deliver what it claims" call → one more call that groups and
// names the PR map's cards (DESIGN.md §6.4), best-effort.
//
// Kept out of `worker/index.ts` and out of lib/jobs' barrel on purpose, for
// the same reason as `./analyze.ts`: this is the unit of work (importable
// from a script or test without starting a queue consumer), and it pulls in
// lib/ai + lib/github, which the app bundle has no reason to carry just
// because a route imported `@/lib/jobs` to enqueue something.

import { createHash, randomUUID } from "node:crypto";
import { UnrecoverableError } from "./runner";
import {
  DEFAULT_REVIEW_EFFORT,
  REVIEW_EFFORT_SETTINGS,
  reviewComponentChange,
} from "@/lib/ai";
import {
  deleteFindingsForTargetExceptComponents,
  deleteReviewSlot,
  deleteReviewSlotsExcept,
  getFileOwnerMap,
  getRepoById,
  listFindingSuppressions,
  listFindingsByTargetKey,
  listReviewSlots,
  replaceFindingsForTargetCategory,
  restampFindingsForTargetComponent,
  syncFindingsForTargetComponent,
  writeReviewSlot,
} from "@/lib/db";
import type { AcceptanceCriterionAnswer, TargetFindingInput } from "@/lib/db";
import type { JobLogger } from "./analyze";
import {
  getComponentReviewContexts,
  matchFilesToComponents,
  type ComponentReviewContext,
} from "./diff-components";
import { openHeadSource } from "./head-source";
import { runImpactPass } from "./impact";
import { loadTargetAnalyses, movedCodeChanges } from "./symbol-context";
import { compareApis } from "@/lib/analysis/api/compare";
import { compareInfra } from "@/lib/analysis/infra/compare";
import { compareEnv } from "@/lib/analysis/env/compare";
import { describeEnvChange, envChangeSummary } from "@/lib/analysis/env/describe";
import { compareSchemas, schemaChanged } from "@/lib/analysis/db/compare";
import { describeSchemaChange, schemaChangeSummary } from "@/lib/analysis/db/describe";
import { describeInfraChange, infraChangeSummary } from "@/lib/analysis/infra/describe";
import { apiChangeSummary, describeApiChange } from "@/lib/analysis/api/describe";
import { componentReviewContext, type TargetChangeContext } from "./review-context";
import { ownerLookup } from "./target-graph";
import {
  type LocalFilePatch,
} from "./local-git";
import {
  REVIEW_CANCELLED_REASON,
  reviewTargetKey,
  type ReviewJob,
  type ReviewJobData,
  type ReviewJobResult,
  type ReviewProgress,
} from "./review-queue";
import { runIntentPass, runPrMapPass, saveAcceptanceCriteria } from "./review-passes";
import { runTestPlanPass } from "./test-plan";
import { compareTests } from "@/lib/analysis/tests/compare";
import { buildCallGraph } from "@/lib/analysis/compare";
import { loadAiConfig, resolveTarget, loadOwnerNames } from "./review-target";

/**
 * How many per-component LLM calls are in flight at once.
 *
 * Small on purpose. The whole point of per-component calls is that they are
 * independent and can be parallelized, but the configured provider may well
 * be a single local model server that serializes internally anyway, and a
 * burst of dozens of concurrent requests is the fastest way to trip a hosted
 * provider's rate limit — which, with `attempts: 1`, there is no automatic
 * second chance for.
 */
const MODEL_CONCURRENCY = 3;

/**
 * What a component's review call is about, as one hash: its changed files'
 * patches (hunk headers included, so a shifted line counts as a change),
 * the model and the effort. Equal hashes at two heads mean the call would be
 * sent the same diff, so an incremental re-review keeps its findings
 * (DESIGN.md §6.21). Related-code context is deliberately not part of it.
 */
function componentPatchHash(files: readonly LocalFilePatch[], model: string, effort: string): string {
  const hash = createHash("sha256").update(`${model}\0${effort}\0`);
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    // A file without diff text (binary, or too big) can't be compared: the
    // component is never reused, rather than risk keeping stale findings.
    hash.update(`${file.path}\0${file.status}\0${file.patch ?? randomUUID()}\0`);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// AI provider settings
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Diff + intent sources
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The PR map pass
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The PR-level intent pass
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * Runs one full review. Throws only on failures that make the *whole* run
 * impossible (repo gone, AI unconfigured, diff unfetchable) — an individual
 * component whose model call fails is recorded and stepped over, never
 * allowed to abort the run, since by then the other components' calls have
 * already been paid for and `attempts: 1` means there is no second chance.
 *
 * `signal` (aborted when the user cancels, worker/index.ts) stops the run
 * where it is: calls in flight are aborted, no further component is started,
 * and the job fails with {@link REVIEW_CANCELLED_REASON}. Findings already
 * written for finished components stay; nothing after that point is written,
 * and findings of components the target no longer touches are not pruned —
 * that only happens once every touched component has been reviewed.
 */
export async function runReviewJob(
  data: ReviewJobData,
  job?: Pick<ReviewJob, "updateProgress">,
  log: JobLogger = (message) => console.log(`[review] ${message}`),
  signal?: AbortSignal
): Promise<ReviewJobResult> {
  const startedAt = Date.now();
  const { repoId, target } = data;
  const targetKey = reviewTargetKey(target);
  const effort = data.effort ?? DEFAULT_REVIEW_EFFORT;
  const effortSettings = REVIEW_EFFORT_SETTINGS[effort];

  const progress: ReviewProgress = {
    total: 0,
    completed: 0,
    failed: 0,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    running: [],
    unmatchedFiles: 0,
    effort,
  };
  // Keyed by component id, not name: two components can legitimately share a
  // display name, and removing one from a name-keyed set would drop both
  // from the "currently running" list.
  const running = new Map<string, string>();
  const publishProgress = async (): Promise<void> => {
    progress.running = [...running.values()];
    try {
      // Progress is advisory (a live counter) — a hiccup writing
      // it must never take down a job that is otherwise succeeding.
      await job?.updateProgress({ ...progress });
    } catch {
      /* ignored */
    }
  };
  /** Ends a cancelled run, leaving the final cost counter behind for the UI. */
  const stopIfCancelled = async (): Promise<void> => {
    if (!signal?.aborted) return;
    running.clear();
    await publishProgress();
    log(
      `cancelled after ${progress.calls} model call(s) — the findings of ` +
        `${progress.completed + progress.failed} finished component(s) are kept`
    );
    throw new UnrecoverableError(REVIEW_CANCELLED_REASON);
  };

  const repo = await getRepoById(repoId);
  if (!repo) {
    throw new UnrecoverableError(`Repo ${repoId} no longer exists — nothing to review.`);
  }

  const aiConfig = await loadAiConfig();
  log(
    `repo ${repo.name} (${repo.provider}) · target ${targetKey} · model ${aiConfig.model} · ` +
      `effort ${effort} (${effortSettings.tokenBudget} token budget per call)`
  );

  const resolved = await resolveTarget(repo, target, log);
  log(`diff source: ${resolved.description} — ${resolved.files.length} changed file(s)`);
  await stopIfCancelled();
  // Stamped on every finding this run writes (see `ResolvedTarget.reviewed`).
  // `reviewedAt` is the moment the shas were captured, not when each
  // component happened to finish.
  const reviewedAt = new Date().toISOString();
  const revision = {
    ...(resolved.reviewed.baseSha ? { reviewedBaseSha: resolved.reviewed.baseSha } : {}),
    ...(resolved.reviewed.headSha ? { reviewedHeadSha: resolved.reviewed.headSha } : {}),
    reviewedAt,
  };

  // The code as the target leaves it — for related-code context and the
  // impact pass. `null` (logged) falls back to the default branch / skips.
  const head = await openHeadSource(repo, target, resolved.reviewed.headSha, log);
  await stopIfCancelled();
  // The target's base and head analysed from names (TS/JS, Python, Java,
  // Kotlin): the impact pass and the related-code context read from it.
  const analyses = await loadTargetAnalyses(repo, target, resolved.reviewed, head, log);
  await stopIfCancelled();
  const ownerNames = analyses ? await loadOwnerNames(repoId) : null;
  // Code moved to another file and changed on the way: each side's review sees the
  // old copy against the new one, and the impact pass judges the callers against it.
  const moved = analyses && head ? await movedCodeChanges(analyses, (path) => head.read(path)) : [];
  if (moved.length > 0) log(`moved and changed on the way: ${moved.map((m) => `${m.name} (${m.from} → ${m.to}, ${m.changed})`).join(", ")}`);
  // What the change does to the endpoints: each component's review sees the
  // ones it serves or sits behind, the intent check sees all of them.
  const apiChange = analyses ? compareApis(analyses.base, analyses.head, analyses.changed) : null;
  if (apiChange && (apiChange.changes.length > 0 || apiChange.logic.length > 0)) log(`API: ${apiChangeSummary(apiChange)} Logic changed behind ${apiChange.logic.length}.`);
  // What it does to the infrastructure: each component's review sees the
  // changes to its infra files and to the workloads that deploy its code,
  // with the certain infra findings marked as already reported; the intent
  // check sees the whole plan.
  const infraChange = analyses ? compareInfra(analyses.base.infra, analyses.head.infra) : null;
  const infraChanged = Boolean(infraChange && (infraChange.changes.length > 0 || infraChange.links.length > 0));
  if (infraChange && infraChanged) log(`infra: ${infraChangeSummary(infraChange)}`);
  // What it does to the database schema: each component's review sees the
  // full definition of every table its code touches, the change marked, with
  // the certain schema findings as already reported; the intent check sees
  // the whole schema change (DESIGN.md §6.13 §6).
  const dbChange = analyses ? compareSchemas(analyses.base.db, analyses.head.db) : null;
  const dbChanged = schemaChanged(dbChange ?? undefined);
  if (dbChange && dbChanged) log(`schema: ${schemaChangeSummary(dbChange)}`);
  // What it does to the env vars: each component's review sees the names its
  // files read, declare or set (secret values masked), with the certain env
  // findings as already reported; the intent check sees the whole change
  // (DESIGN.md §6.15 §5).
  const envChange = analyses ? compareEnv(analyses.base.env, analyses.head.env, analyses.changed, infraChange?.findings ?? []) : null;
  const envChanged = Boolean(envChange && envChange.changes.length > 0);
  if (envChange && envChanged) log(`env: ${envChangeSummary(envChange)}`);
  const targetChanges: TargetChangeContext = { analyses, head, ownerNames, moved, apiChange, infraChange, infraChanged, dbChange, envChange };

  // --- Map the diff onto the component graph -----------------------------
  const filesByPath = new Map(resolved.files.map((file) => [file.path, file]));
  const match = await matchFilesToComponents(repoId, [...filesByPath.keys()]);
  // A migration or schema file only the head has (a new migration) isn't in
  // the analysed graph: it joins the component owning its nearest analysed
  // folder, so a change that only adds a migration is still reviewed, with
  // its tables as context (DESIGN.md §6.13 §6). A new env source (an
  // `.env.example`, a workflow) does the same, with its env names as context
  // (§6.15 §5). Other new files keep the existing behaviour.
  const headSchemaFiles = new Set([
    ...(analyses?.head.db.databases ?? []).flatMap((d) => [...d.migrations.map((m) => m.file), ...d.tables.map((t) => t.definedAt.file)]),
    ...(analyses?.head.env.vars ?? []).flatMap((v) => [...v.sets.map((x) => x.file), ...v.decls.map((x) => x.file)]),
  ]);
  if (match.unmatchedFiles.some((path) => headSchemaFiles.has(path))) {
    const ownerOf = ownerLookup(await getFileOwnerMap(repoId));
    const still: string[] = [];
    for (const path of match.unmatchedFiles) {
      const id = headSchemaFiles.has(path) ? ownerOf(path) : undefined;
      if (!id) {
        still.push(path);
        continue;
      }
      match.componentIdByPath.set(path, id);
      const group = match.pathsByComponentId.get(id);
      if (group) group.push(path);
      else match.pathsByComponentId.set(id, [path]);
      if (!match.touchedComponentIds.includes(id)) match.touchedComponentIds.push(id);
    }
    match.unmatchedFiles = still;
  }
  const contexts = await getComponentReviewContexts(repoId, match.touchedComponentIds);
  log(
    `mapped to ${contexts.length} touched component(s); ` +
      `${match.unmatchedFiles.length} changed path(s) matched no analyzed file`
  );

  // --- "Retry failed": only the parts whose model call never completed ----
  // Everything else the last run wrote stays as it is (and isn't paid for
  // again). Only safe while the target is where that run left it — once the
  // head moves, the kept findings describe other code, so it's a full run.
  let retry: { componentIds: Set<string>; intent: boolean } | undefined;
  if (data.only === "failed") {
    const existing = await listFindingsByTargetKey(repoId, targetKey);
    const failed = existing.filter((finding) => finding.callFailed);
    const headSha = resolved.reviewed.headSha;
    const sameHead = !headSha || existing.every((f) => !f.reviewedHeadSha || f.reviewedHeadSha === headSha);
    if (failed.length === 0) {
      log("retry requested but nothing failed — running the full review");
    } else if (!sameHead) {
      log("the target moved since the last review — running a full review instead of retrying failures");
    } else {
      retry = {
        componentIds: new Set(failed.filter((f) => f.category === "change").map((f) => f.componentId)),
        intent: failed.some((f) => f.category === "intent"),
      };
      log(
        `retrying ${retry.componentIds.size} failed component(s)` +
          (retry.intent ? " and the intent check" : "") +
          "; keeping every other finding"
      );
    }
  }
  const filesOf = (componentId: string): LocalFilePatch[] =>
    (match.pathsByComponentId.get(componentId) ?? [])
      .map((path) => filesByPath.get(path))
      .filter((file): file is LocalFilePatch => Boolean(file));
  const patchHashes = new Map(contexts.map((context) => [context.id, componentPatchHash(filesOf(context.id), aiConfig.model, effort)]));

  /** A few finding summaries per component, for the PR map pass. */
  const summariesByComponent = new Map<string, string[]>();
  /** One line per finding, for the PR-level intent call. */
  const findingLines: string[] = [];

  // --- Incremental re-review: keep components the push didn't change ----
  // After the head moved, a component whose patch hashes the same as the
  // one its last call saw would be sent the same diff: its findings (and
  // their triage) stay, restamped with the new head, and no call is made.
  // Re-running at the same head re-calls everything — that is a deliberate
  // "ask again" (DESIGN.md §6.21).
  const reused = new Set<string>();
  const headSha = resolved.reviewed.headSha;
  if (!retry && headSha) {
    const slots = listReviewSlots(repoId, targetKey);
    const stored = await listFindingsByTargetKey(repoId, targetKey);
    const failedComponents = new Set(stored.filter((f) => f.category === "change" && f.callFailed).map((f) => f.componentId));
    for (const context of contexts) {
      const slot = slots.get(context.id);
      if (!slot || slot.headSha === headSha || slot.patchHash !== patchHashes.get(context.id) || failedComponents.has(context.id)) continue;
      reused.add(context.id);
      const kept = await restampFindingsForTargetComponent(repoId, targetKey, context.id, revision);
      writeReviewSlot(repoId, targetKey, { componentId: context.id, patchHash: slot.patchHash, headSha, reviewedAt });
      summariesByComponent.set(context.id, kept.slice(0, 3).map((finding) => finding.summary));
      for (const finding of kept) {
        const labels = [finding.kind, finding.scope, finding.assessment].filter(Boolean).join(", ");
        findingLines.push(`${finding.filePath ?? context.name}: ${finding.summary} (${labels})`);
      }
    }
    if (reused.size > 0) log(`${reused.size} component(s) unchanged since the last review — their findings are reused, no call`);
  }

  const toReview = retry
    ? contexts.filter((context) => retry.componentIds.has(context.id))
    : contexts.filter((context) => !reused.has(context.id));

  progress.total = toReview.length;
  progress.reused = reused.size;
  progress.unmatchedFiles = match.unmatchedFiles.length;
  await publishProgress();

  // Findings the reviewer dismissed as "not a problem" on this repo: each
  // component's call is told about the ones on its files (DESIGN.md §6.21).
  const suppressions = listFindingSuppressions(repoId);

  // --- One call per component, a few at a time ---------------------------
  let findingsWritten = 0;
  let nextIndex = 0;
  // Persistence is funnelled through this promise chain so that, however
  // many model calls finish at once, findings are written one component at
  // a time and in completion order.
  let writeChain: Promise<unknown> = Promise.resolve();

  const reviewOne = async (context: ComponentReviewContext): Promise<void> => {
    const paths = match.pathsByComponentId.get(context.id) ?? [];
    const files = filesOf(context.id);
    const pathSet = new Set(paths);
    const knownNonIssues = suppressions
      .filter((s) => pathSet.has(s.filePath))
      .map((s) => ({ filePath: s.filePath, summary: s.summary, ...(s.reason ? { reason: s.reason } : {}) }));

    running.set(context.id, context.name);
    await publishProgress();

    let findings: TargetFindingInput[];
    let failed = false;
    let sent = false;

    try {
      const relatedWithMoves = await componentReviewContext({
        repo,
        componentId: context.id,
        paths,
        patches: files.map((file) => file.patch ?? ""),
        settings: effortSettings,
        target: targetChanges,
        log: (message) => log(`${context.name}: ${message}`),
      });
      signal?.throwIfAborted();
      sent = true;
      const result = await reviewComponentChange(
        aiConfig,
        {
          intent: resolved.intent,
          component: {
            id: context.id,
            name: context.name,
            description: context.description,
            dependsOn: context.dependsOn,
            dependents: context.dependents,
          },
          files,
          related: knownNonIssues.length > 0 ? { ...relatedWithMoves, knownNonIssues } : relatedWithMoves,
        },
        { tokenBudget: effortSettings.tokenBudget, signal }
      );

      progress.calls += result.calls;
      progress.promptTokens += result.usage.promptTokens;
      progress.completionTokens += result.usage.completionTokens;
      summariesByComponent.set(
        context.id,
        result.findings.slice(0, 3).map((finding) => finding.summary)
      );
      for (const finding of result.findings) {
        const labels = [finding.kind, finding.scope, finding.assessment].filter(Boolean).join(", ");
        findingLines.push(`${finding.filePath ?? context.name}: ${finding.summary} (${labels})`);
      }

      findings = result.findings.map((finding) => ({
        id: randomUUID(),
        prId: resolved.prId,
        filePath: finding.filePath,
        lineRange: finding.lineRange,
        summary: finding.summary,
        assessment: finding.assessment,
        scope: finding.scope,
        kind: finding.kind,
        confidence: finding.confidence,
        rationale: finding.rationale,
        model: aiConfig.model,
        createdAt: new Date().toISOString(),
        ...revision,
      }));
      log(
        `${context.name}: ${findings.length} finding(s) from ${files.length} changed file(s)` +
          (result.chunks > 1 ? ` in ${result.chunks} parts` : "") +
          (relatedWithMoves?.files?.length ? `, ${relatedWithMoves.files.length} related file(s) as context` : "") +
          (result.truncated ? " (diff truncated)" : "") +
          (result.parseFailed ? " (model output could not be parsed)" : "")
      );
    } catch (error) {
      if (signal?.aborted) {
        // Cut off by a cancel. Nothing is written, so whatever this component
        // had from an earlier run stays as it was — and it isn't a failed call
        // for "Retry failed" to pick up. A call in flight may still be billed.
        if (sent) progress.calls += 1;
        running.delete(context.id);
        await publishProgress();
        return;
      }
      failed = true;
      // A rejected call still went out (and, with a hosted provider, may
      // still be billed), so it counts toward the running call counter.
      // One is a lower bound — `reviewComponentChange` only throws after its
      // own attempts are exhausted and doesn't report how many it made.
      progress.calls += 1;
      // `AiClientError` (lib/ai) already carries a message naming the status
      // / network failure, so it needs no special-casing beyond `Error`.
      const message = error instanceof Error ? error.message : String(error);
      // A failed component becomes a visible `unknown` finding rather than
      // silence: reviews run automatically for every touched component,
      // so "nothing was said about this component" must not be ambiguous
      // between "the model found nothing" and "the call never landed".
      findings = [
        {
          id: randomUUID(),
          prId: resolved.prId,
          summary: `Review of ${context.name} failed.`,
          assessment: "unknown",
          confidence: 0,
          rationale: `The AI review call for this component did not complete: ${message}`,
          callFailed: true,
          model: aiConfig.model,
          createdAt: new Date().toISOString(),
          ...revision,
        },
      ];
      log(`${context.name}: model call failed — ${message}`);
    }

    running.delete(context.id);

    const write = writeChain.then(async () => {
      await syncFindingsForTargetComponent(repoId, targetKey, context.id, findings);
      // What this call saw, for the next run's incremental check — or, for a
      // failed call, nothing, so the next run makes it again.
      if (failed || !headSha) deleteReviewSlot(repoId, targetKey, context.id);
      else writeReviewSlot(repoId, targetKey, { componentId: context.id, patchHash: patchHashes.get(context.id)!, headSha, reviewedAt });
    });
    // Keep the chain alive even when this link rejects, so one failed write
    // can't poison every component queued behind it.
    writeChain = write.catch(() => undefined);
    try {
      await write;
      findingsWritten += findings.length;
    } catch (error) {
      failed = true;
      log(`${context.name}: persisting findings failed — ${(error as Error).message}`);
    }

    if (failed) progress.failed += 1;
    else progress.completed += 1;
    await publishProgress();
  };

  const runner = async (): Promise<void> => {
    // A cancel stops the next component from starting; the ones in flight
    // are aborted inside `reviewOne`.
    for (let index = nextIndex++; index < toReview.length && !signal?.aborted; index = nextIndex++) {
      await reviewOne(toReview[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MODEL_CONCURRENCY, toReview.length) }, runner)
  );
  // Before pruning: a cancelled run hasn't looked at every touched component.
  await stopIfCancelled();

  // --- Drop findings for components this target no longer touches -------
  const prunedFindings = await deleteFindingsForTargetExceptComponents(
    repoId,
    targetKey,
    contexts.map((context) => context.id)
  );
  deleteReviewSlotsExcept(repoId, targetKey, contexts.map((context) => context.id));
  if (prunedFindings > 0) {
    log(`pruned ${prunedFindings} finding(s) for components no longer touched`);
  }

  // Impact and intent findings are replaced wholesale per run, through the
  // same serialised write chain as the component findings.
  const persistCategory = async (
    category: "impact" | "intent",
    findings: Parameters<typeof replaceFindingsForTargetCategory>[3]
  ): Promise<void> => {
    const write = writeChain.then(() => replaceFindingsForTargetCategory(repoId, targetKey, category, findings));
    writeChain = write.catch(() => undefined);
    try {
      await write;
      findingsWritten += findings.length;
    } catch (error) {
      log(`persisting ${category} findings failed — ${(error as Error).message}`);
    }
  };

  // The intent pass's per-criterion verdicts, as the checklist's acceptance-criteria answer (DESIGN.md §6.27).
  const saveIntentCriteria = async (criteria: AcceptanceCriterionAnswer[] | undefined) => {
    try {
      await saveAcceptanceCriteria({ repoId, targetKey, headSha: revision.reviewedHeadSha, model: aiConfig.model, criteria });
    } catch (error) {
      log(`saving the acceptance-criteria verdicts failed — ${(error as Error).message}`);
    }
  };

  if (retry) {
    // The intent call sees one line per finding — the kept ones included.
    if (retry.intent && resolved.intent.source === "pull_request") {
      const lines = (await listFindingsByTargetKey(repoId, targetKey))
        .filter((f) => f.category !== "intent" && !f.callFailed)
        .map((f) => `${f.filePath ?? f.componentName}: ${f.summary} (${[f.kind, f.scope, f.assessment].filter(Boolean).join(", ")})`);
      running.set("__intent", "Intent check");
      await publishProgress();
      const intentPass = await runIntentPass({
        intent: resolved.intent,
        files: resolved.files,
        findingLines: lines,
        ...(apiChange && (apiChange.changes.length || apiChange.logic.length) ? { apiLines: describeApiChange(apiChange) } : {}),
        ...(infraChange && infraChanged ? { infraLines: describeInfraChange(infraChange) } : {}),
        ...(dbChange && dbChanged ? { schemaLines: describeSchemaChange(dbChange) } : {}),
        ...(envChange && envChanged ? { envLines: describeEnvChange(envChange) } : {}),
        aiConfig,
        tokenBudget: effortSettings.tokenBudget,
        prId: resolved.prId,
        revision,
        log,
        signal,
      });
      running.delete("__intent");
      progress.calls += intentPass.calls;
      progress.promptTokens += intentPass.promptTokens;
      progress.completionTokens += intentPass.completionTokens;
      await stopIfCancelled();
      await persistCategory("intent", [intentPass.finding]);
    await saveIntentCriteria(intentPass.criteria);
      await saveIntentCriteria(intentPass.criteria);
    }
    await publishProgress();
    return finish();
  }

  // --- Usages the change left behind ----------------------------------------
  running.set("__impact", "Impact check");
  await publishProgress();
  const impact = await runImpactPass({
    repoId,
    files: resolved.files,
    head,
    aiConfig,
    tokenBudget: effortSettings.tokenBudget,
    prId: resolved.prId,
    revision,
    log,
    signal,
    analyses,
    moved,
  });
  running.delete("__impact");
  progress.calls += impact.calls;
  progress.promptTokens += impact.promptTokens;
  progress.completionTokens += impact.completionTokens;
  // A cut-off pass found nothing; writing that would wipe the last run's impact findings.
  await stopIfCancelled();
  await persistCategory("impact", impact.findings);
  for (const finding of impact.findings) {
    if (finding.assessment !== "ok") findingLines.push(`${finding.filePath}: ${finding.summary} (impact, ${finding.assessment})`);
  }

  // --- Does the PR deliver what it claims? ----------------------------------
  if (resolved.intent.source === "pull_request") {
    running.set("__intent", "Intent check");
    await publishProgress();
    const intentPass = await runIntentPass({
      intent: resolved.intent,
      files: resolved.files,
      findingLines,
      ...(apiChange && (apiChange.changes.length || apiChange.logic.length) ? { apiLines: describeApiChange(apiChange) } : {}),
      ...(infraChange && infraChanged ? { infraLines: describeInfraChange(infraChange) } : {}),
      ...(dbChange && dbChanged ? { schemaLines: describeSchemaChange(dbChange) } : {}),
      ...(envChange && envChanged ? { envLines: describeEnvChange(envChange) } : {}),
      aiConfig,
      tokenBudget: effortSettings.tokenBudget,
      prId: resolved.prId,
      revision,
      log,
      signal,
    });
    running.delete("__intent");
    progress.calls += intentPass.calls;
    progress.promptTokens += intentPass.promptTokens;
    progress.completionTokens += intentPass.completionTokens;
    await stopIfCancelled();
    await persistCategory("intent", [intentPass.finding]);
  } else {
    await persistCategory("intent", []);
  }

  // --- Group and name the PR map (DESIGN.md §6.4) -------------------------
  running.set("__pr-map", "PR map");
  await publishProgress();
  const prMapSpent = await runPrMapPass({
    repoId,
    targetKey,
    prId: resolved.prId,
    files: resolved.files,
    intent: resolved.intent,
    summariesByComponent,
    aiConfig,
    tokenBudget: effortSettings.tokenBudget,
    log,
    signal,
  });
  running.delete("__pr-map");
  progress.calls += prMapSpent.calls;
  progress.promptTokens += prMapSpent.promptTokens;
  progress.completionTokens += prMapSpent.completionTokens;
  await stopIfCancelled();

  // --- What to test before it merges (DESIGN.md §6.22 §5) -----------------
  running.set("__test-plan", "Test plan");
  await publishProgress();
  const testPlanSpent = await runTestPlanPass({
    repoId,
    targetKey,
    target,
    title: resolved.intent.title,
    headSha: resolved.reviewed.headSha,
    ...(apiChange && (apiChange.changes.length || apiChange.logic.length) ? { apiLines: describeApiChange(apiChange) } : {}),
    ...(infraChange && infraChanged ? { infraLines: describeInfraChange(infraChange) } : {}),
    ...(dbChange && dbChanged ? { schemaLines: describeSchemaChange(dbChange) } : {}),
    ...(envChange && envChanged ? { envLines: describeEnvChange(envChange) } : {}),
    tests: analyses ? compareTests(analyses.base.tests, analyses.head.tests, analyses.changed) : null,
    ...(analyses ? { callGraph: buildCallGraph(analyses.base, analyses.head, analyses.changed) } : {}),
    aiConfig,
    tokenBudget: effortSettings.tokenBudget,
    log,
    signal,
  });
  running.delete("__test-plan");
  progress.calls += testPlanSpent.calls;
  progress.promptTokens += testPlanSpent.promptTokens;
  progress.completionTokens += testPlanSpent.completionTokens;
  await stopIfCancelled();

  await publishProgress();
  return finish();

  function finish(): ReviewJobResult {
    const durationMs = Date.now() - startedAt;
    log(
      `done in ${durationMs}ms — ${progress.completed} component(s) reviewed, ` +
        (reused.size > 0 ? `${reused.size} unchanged and reused, ` : "") +
        `${progress.failed} failed, ${findingsWritten} finding(s), ${progress.calls} model call(s), ` +
        `${progress.promptTokens}+${progress.completionTokens} token(s)`
    );

    return {
      repoId,
      targetKey,
      components: toReview.length,
      failedComponents: progress.failed,
      findings: findingsWritten,
      calls: progress.calls,
      promptTokens: progress.promptTokens,
      completionTokens: progress.completionTokens,
      prunedFindings,
      ...(reused.size > 0 ? { reusedComponents: reused.size } : {}),
      durationMs,
      ...(resolved.reviewed.baseSha ? { reviewedBaseSha: resolved.reviewed.baseSha } : {}),
      ...(resolved.reviewed.headSha ? { reviewedHeadSha: resolved.reviewed.headSha } : {}),
      reviewedAt,
    };
  }
}
