// Wire shapes for feature merges (DESIGN.md §6.3) — the contract between
// app/api/repos/[repoId]/merges/** and the Graph tab. Duplicated from
// lib/neo4j's types rather than imported, for the same client/server
// boundary reason as ./types.ts.

export type MergeSuggestionKindDTO = "merge" | "extend" | "move-file";

export interface MergeSuggestionDTO {
  id: string;
  kind: MergeSuggestionKindDTO;
  /** `<dir>/**` folder patterns, or exact file paths for `move-file`. */
  members: string[];
  /** The merged module an `extend`/`move-file` adds to. */
  targetComponentId?: string;
  /** Proposed name (merge) or the target's name (extend/move-file). */
  name: string;
  /** 0–1. */
  score: number;
  reasons: string[];
  status: "open" | "rejected";
  /** Graph node ids that currently own the member files — highlighted on the canvas as a preview. */
  memberComponentIds: string[];
}

export interface MergedModuleDTO {
  id: string;
  name: string;
  description?: string;
  pathPatterns: string[];
}

/** `GET /api/repos/[repoId]/merges`. */
export interface MergesResponseDTO {
  suggestions: MergeSuggestionDTO[];
  merged: MergedModuleDTO[];
  /** A merge/unmerge moved modules between domains since the last labeling run. */
  domainsStale: boolean;
  aiConfigured: boolean;
}

/** `POST /api/repos/[repoId]/merges` with `{action: "accept-all"}`. */
export interface AcceptAllResponseDTO {
  accepted: number;
  /** Overlapped a stronger suggestion accepted in the same pass; recomputed afterwards. */
  skipped: number;
  /** New merged modules, still carrying their heuristic names. */
  createdComponentIds: string[];
}

/** `POST /api/repos/[repoId]/merges/suggestions/[suggestionId]`. */
export type SuggestionActionDTO = { action: "accept" } | { action: "reject" } | { action: "reopen" };

export interface AcceptSuggestionResponseDTO {
  componentId: string;
}

/** `POST /api/repos/[repoId]/merges/modules/[componentId]`. */
export type MergedModuleActionDTO =
  | { action: "unmerge" }
  | { action: "rename"; name: string; description?: string }
  | { action: "name-with-ai" };

export interface NameWithAiResponseDTO {
  named: boolean;
  name: string;
  description?: string;
}
