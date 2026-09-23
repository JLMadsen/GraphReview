// Wire shapes for the AI labeling feature — the contract
// between `app/api/repos/[repoId]/label` and the Graph tab's Labels control.
//
// A separate file from `./types.ts` for the same reason that file exists at
// all: these must be importable from a client component, and the route
// module that defines them server-side pulls in lib/neo4j and lib/jobs (a
// Neo4j driver and a Redis connection), which must never reach a client
// bundle. Duplicated deliberately, not imported.

/** Which part of a labeling run is in flight. Mirrors `LabelPhaseName` in lib/jobs. `saving` can't be cancelled. */
export type LabelPhaseDTO = "domains" | "descriptions" | "saving";

/** Lifecycle of a repo's labeling run. `"none"` means "never labeled". */
export type LabelStateDTO = "none" | "queued" | "running" | "completed" | "failed" | "cancelled";

/** Live progress of a labeling run — the same "running counter" idea as a review's. */
export interface LabelProgressDTO {
  phase: LabelPhaseDTO;
  /** Modules handled so far in the current phase. */
  done: number;
  /** Modules in the current phase in total. */
  total: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

/** Response shape for `GET /api/repos/[repoId]/label`. */
export interface LabelStatusResponseDTO {
  state: LabelStateDTO;
  progress?: LabelProgressDTO;
  /** A failed job's reason, or a degraded-read note (e.g. Redis down). */
  error?: string;
  /** `running` only: a cancel was requested and the worker hasn't stopped yet. */
  cancelRequested?: boolean;
  /** When the last run finished, while its job is still retained. */
  finishedAt?: string;
  /** A completed run that still needs explaining (e.g. no usable domains, old ones kept). */
  warning?: string;
  /** Whether base URL + key + model are all set. `false` must suppress every POST. */
  aiConfigured: boolean;
  domains: number;
  describedModules: number;
  modules: number;
}

/** Response shape for `POST /api/repos/[repoId]/label`. */
export interface EnqueueLabelResponseDTO {
  jobId: string;
  /** `false` when a labeling run for this repo was already queued or running. */
  enqueued: boolean;
}

/** Response shape for `DELETE /api/repos/[repoId]/label`. */
export interface CancelLabelResponseDTO {
  outcome: "removed" | "requested" | "not_running";
}

/** Error envelope the label verbs share. `code` is `ai_not_configured` | `queue_unavailable`. */
export interface LabelErrorDTO {
  error: string;
  code?: string;
}

/** What `useLabels` hands to the toolbar control. */
export interface LabelSnapshot {
  /** `loading` = first GET in flight. */
  status: "loading" | "ready" | "error";
  state: LabelStateDTO;
  progress?: LabelProgressDTO;
  aiConfigured: boolean;
  domains: number;
  describedModules: number;
  modules: number;
  /** Inline message: a failed job's reason, a 503, a fetch error… */
  notice: string | null;
  /** `ai_not_configured` | `queue_unavailable`, when the server sent one. */
  noticeCode: string | null;
  /** True between the POST and the first poll that reflects it. */
  starting: boolean;
  /** A cancel has been sent (by this tab, or reported by the server) and the run hasn't stopped yet. */
  cancelling: boolean;
  finishedAt?: string;
}

export interface UseLabelsResult extends LabelSnapshot {
  /** Enqueue a run. `force` also replaces module descriptions that already have text. */
  generate: (options?: { force?: boolean }) => void;
  /** Whether pressing the button could do anything right now. */
  canGenerate: boolean;
  /** Cancel the queued or running run. Nothing is saved from a cancelled run. */
  cancel: () => void;
  /** A run is pending, not already being cancelled, and not in its (uncancellable) saving phase. */
  canCancel: boolean;
  /** True once this repo has a domain tier or any module description. */
  hasLabels: boolean;
  /** True while a run is queued or active. */
  running: boolean;
  /** The status endpoint with `logs=1` — feeds `JobLogHover` on the "Labeling…" spinner. */
  logsUrl: string;
}

export function isLabelPending(state: LabelStateDTO): boolean {
  return state === "queued" || state === "running";
}

/** Human label for the phase currently in flight, for the progress line. */
export function labelPhaseLabel(phase: LabelPhaseDTO): string {
  if (phase === "saving") return "Saving labels";
  return phase === "domains" ? "Grouping modules into domains" : "Describing modules";
}

/** `"just now"`, `"12 min ago"`, `"3 h ago"`, `"2 days ago"`; empty for a missing/invalid time. */
export function formatAgo(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** `"3 calls · 12.4k prompt + 900 completion tokens"` — the cost counter, in the toolbar's space budget. */
export function formatLabelCost(progress: LabelProgressDTO): string {
  const calls = `${progress.calls} call${progress.calls === 1 ? "" : "s"}`;
  const tokens = progress.promptTokens + progress.completionTokens;
  if (tokens === 0) return calls;
  return `${calls} · ${formatTokenCount(tokens)} tokens`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}
