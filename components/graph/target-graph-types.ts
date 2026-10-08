// Wire shapes for `GET /api/repos/[repoId]/target-graph` — a review target's
// base-vs-head comparison: structure change + call graph (lib/jobs/target-graph.ts).
// Type-only imports: nothing server-side reaches the client bundle.

import type { CallGraph, CallGraphEdge, CallGraphFunction, FunctionStatus } from "@/lib/analysis/compare";
import type { ComponentDependencyChange, TargetGraphData } from "@/lib/jobs/target-graph-queue";

export type { CallGraph, CallGraphEdge, CallGraphFunction, ComponentDependencyChange, FunctionStatus, TargetGraphData };

export interface TargetGraphResponseDTO {
  /** The comparison job: `completed` with `data`, or still working (the last result, if any, is in `data`). */
  state: "none" | "queued" | "running" | "completed" | "failed";
  error?: string;
  baseSha?: string;
  headSha?: string;
  computedAt?: string;
  data?: TargetGraphData;
}
