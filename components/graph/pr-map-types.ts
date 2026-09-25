// Wire shapes for the PR map (DESIGN.md §6.4) — the Graph tab's "PR" view:
// one card per group of changed files, labelled edges between them. Shared
// by `POST /api/repos/[repoId]/pr-map`, the builder in lib/jobs/pr-map.ts and
// the React Flow canvas in this directory. Framework/DB-agnostic on purpose,
// like ./types.ts, so a client component can import it.

import type { FileDiffStatus } from "./types";

/**
 * What a card stands for in this change. `context` cards hold no changed
 * files: they are untouched modules the changed code imports or is imported
 * by, drawn faded so the reviewer can see what the change sits next to.
 */
export type PrMapRole = "code" | "test" | "dependency" | "config" | "docs" | "context";

export interface PrMapFileDTO {
  path: string;
  status: FileDiffStatus;
  additions: number;
  deletions: number;
}

export interface PrMapNodeDTO {
  /** Stable within one map (`code:<componentId>`, `test:<key>`, `dep`, `ctx:<componentId>`, `ai:<n>` …). */
  id: string;
  name: string;
  description?: string;
  role: PrMapRole;
  /** Graph component ids behind this card — what selecting it selects on the Repo view. Empty for files no analyzed component owns. */
  componentIds: string[];
  /** Changed files in this card, sorted by path. Always empty for `context`. */
  files: PrMapFileDTO[];
}

export interface PrMapEdgeDTO {
  source: string;
  target: string;
  /** One verb: `imports`, `covers`, `uses`, or whatever the AI pass chose. */
  label: string;
  /** How many file-level links the edge stands for. */
  weight: number;
}

/** Response shape for `POST /api/repos/[repoId]/pr-map`. */
export interface PrMapResponseDTO {
  nodes: PrMapNodeDTO[];
  edges: PrMapEdgeDTO[];
  /** `ai` once the review job's PR map pass has named the groups; `heuristic` otherwise. */
  source: "heuristic" | "ai";
  /** Set on an `ai` map: the model that named it. */
  model?: string;
  /** Present when an AI map exists for this target but the changed files have since changed, so the heuristic map is shown instead. */
  aiOutdated?: boolean;
}

/** Request body accepted by `POST /api/repos/[repoId]/pr-map` — the same three shapes as diff-impact. */
export type PrMapRequestDTO =
  | { prNumber: number }
  | { baseRef: string; headRef: string }
  | { filePaths: string[] };
