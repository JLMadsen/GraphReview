// Wire shapes for the Data view (DESIGN.md §6.13):
//   GET /api/repos/[repoId]/db-schema   the analysed commit's database schema
// The PR's schema change rides on the target graph (target-graph-types.ts).
// Type-only imports: nothing server-side reaches the client bundle.

import type {
  Database,
  DbChange,
  DbColumn,
  DbColumnDelta,
  DbDialect,
  DbDrift,
  DbDriftDelta,
  DbEndpointLink,
  DbEnum,
  DbEnumChange,
  DbFinding,
  DbFk,
  DbIndex,
  DbMigration,
  DbMigrationRef,
  DbSchema,
  DbSourceCandidate,
  DbSourceKind,
  DbTable,
  DbTableChange,
  DbTableStatus,
  DbTableUse,
  DbTool,
  DbUseVia,
} from "@/lib/analysis/db/types";

export type {
  Database,
  DbChange,
  DbColumn,
  DbColumnDelta,
  DbDialect,
  DbDrift,
  DbDriftDelta,
  DbEndpointLink,
  DbEnum,
  DbEnumChange,
  DbFinding,
  DbFk,
  DbIndex,
  DbMigration,
  DbMigrationRef,
  DbSchema,
  DbSourceCandidate,
  DbSourceKind,
  DbTable,
  DbTableChange,
  DbTableStatus,
  DbTableUse,
  DbTool,
  DbUseVia,
};

export interface DbSchemaResponseDTO extends DbSchema {
  /** `none`: the repo hasn't been analysed by a version that builds the catalog yet. */
  state: "ready" | "none";
  sha?: string;
  computedAt?: string;
  /** The repo's pinned source file as chosen now; `pinned` is what the stored catalog was built from (they differ while a re-analysis runs). */
  pin?: string | null;
}

/** `GET /api/repos/[repoId]/db-schema/candidates`. */
export interface DbSourceCandidatesDTO {
  candidates: DbSourceCandidate[];
  /** Every path at the analysed commit, for the search. */
  files: string[];
  truncated: boolean;
  sha?: string;
  pin: string | null;
}
