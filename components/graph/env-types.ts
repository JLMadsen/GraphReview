// Wire shapes for the Env view (DESIGN.md §6.15):
//   GET /api/repos/[repoId]/env-catalog   the analysed commit's env vars
// The PR's env change rides on the target graph (target-graph-types.ts).
// Type-only imports: nothing server-side reaches the client bundle.

import type {
  EnvCatalog,
  EnvCellDelta,
  EnvChange,
  EnvChangeEntry,
  EnvDecl,
  EnvFinding,
  EnvRead,
  EnvScope,
  EnvSet,
  EnvTag,
  EnvTarget,
  EnvVar,
} from "@/lib/analysis/env/types";

export type { EnvCatalog, EnvCellDelta, EnvChange, EnvChangeEntry, EnvDecl, EnvFinding, EnvRead, EnvScope, EnvSet, EnvTag, EnvTarget, EnvVar };

/** `none` before the repo was analysed by a version that builds the catalog. */
export type EnvCatalogResponseDTO = EnvCatalog & {
  /** The component owning each file that reads a var (by path; a file the graph doesn't know takes its folder's). */
  fileComponents: Record<string, { id: string; name: string }>;
} & ({ state: "ready"; sha: string; computedAt: string } | { state: "none" });
