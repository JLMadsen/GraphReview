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
}
