/**
 * The schema catalog: which tables a commit's migrations, schema files and
 * ORM models declare, which code uses them, and what a change does to them
 * (DESIGN.md §6.13). Pure data — built by ./catalog.ts, compared by
 * ./compare.ts, stored as JSON and sent to the browser as is.
 *
 * Static only: no live database, no connection string. Migrations are
 * replayed in order (./replay.ts); nothing is executed.
 */

export type DbDialect = "postgresql" | "mysql" | "sqlite" | "sqlserver";

/** Where a definition comes from, best first: migrations replayed > declarative schema files > ORM models. */
export type DbSourceKind = "migration" | "schema" | "model";

export type DbTool =
  | "prisma"
  | "drizzle"
  | "typeorm"
  | "django"
  | "sqlalchemy"
  | "sqlmodel"
  | "alembic"
  | "golang-migrate"
  | "dbmate"
  | "goose"
  | "supabase"
  | "flyway"
  | "sql";

export interface DbSourceRef {
  tool: DbTool;
  kind: DbSourceKind;
  /** The folder (migrations) or file (schema) it was read from. */
  path: string;
  /** Files read. */
  files: number;
}

export interface DbColumn {
  name: string;
  /** As written in its best source, lower-cased SQL where it came from SQL (`varchar(50)`, `timestamp(3)`), else the ORM's mapped type. */
  type: string;
  nullable: boolean;
  default?: string;
  unique?: true;
  primary?: true;
  /** Identity / serial / auto-increment / `GENERATED … AS (…)`: the expression, or `identity`. */
  generated?: string;
  /** The enum type it holds (its id), when known. */
  enum?: string;
  source: DbSourceKind;
  /** The model attribute that maps it, when one does (`customer` for `customer_id`). */
  modelField?: string;
}

export interface DbIndex {
  name?: string;
  columns: string[];
  unique?: true;
  /** Partial index condition, as written. */
  where?: string;
}

export interface DbFk {
  name?: string;
  columns: string[];
  /** The referenced table's id once resolved, else its name as written. */
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  /** Only an ORM relation declares it — no migration or schema file does. */
  inferred?: true;
}

export interface DbCheck {
  name?: string;
  expr: string;
}

/** One step of a table's history: what a migration did to it. */
export interface DbMigrationRef {
  /** The migration's id ({@link DbMigration.id}). */
  migration: string;
  name: string;
  file: string;
  line: number;
  /** "create table", "add column status", "drop index orders_idx". */
  summary: string;
}

export type DbDriftKind = "field-no-column" | "column-no-field" | "model-no-table" | "table-no-model";

/** A model and the migrations / schema files disagree. Shown and given to the review — never a finding. */
export interface DbDrift {
  kind: DbDriftKind;
  column?: string;
  /** "model field `nickname` has no column in the migrations". */
  text: string;
  file?: string;
  line?: number;
}

/** A model (class, Prisma model, Drizzle table object) that maps a table. */
export interface DbModelRef {
  tool: DbTool;
  name: string;
  file: string;
  line: number;
  /** Its declaration id (`<file>#<name>`), for the symbol graph's references. */
  decl?: string;
}

export interface DbTable {
  /** Stable across commits: `<database>:<schema>.<name>` (lower-cased; the schema only when there is one). */
  id: string;
  database: string;
  schema?: string;
  name: string;
  columns: DbColumn[];
  pk: string[];
  indexes: DbIndex[];
  fks: DbFk[];
  checks: DbCheck[];
  /** The best source that defines it. */
  source: DbSourceKind;
  /** Every kind of source that defines it. */
  sources: DbSourceKind[];
  definedAt: { file: string; line: number };
  /** What the migrations did to it, in order. */
  history: DbMigrationRef[];
  models: DbModelRef[];
  /** Set by the route: the component holding its model, else its migration. */
  component?: { id: string; name: string };
  drift: DbDrift[];
  /** A view rather than a table. */
  view?: true;
  /** Endpoints that read or write it (./link.ts). */
  endpoints?: DbEndpointLink[];
  /** How many places in the code use it, and in how many files. */
  usage?: { uses: number; files: number };
}

export interface DbEnum {
  /** `<database>:<schema>.<name>` like a table's. */
  id: string;
  name: string;
  values: string[];
  file: string;
  line: number;
  source: DbSourceKind;
}

/** A statement or operation the replay doesn't model (data updates, `DO` blocks, `RunPython`, functions). Kept so the history doesn't lose it. */
export interface DbOpaque {
  migration?: string;
  file: string;
  line: number;
  /** As written, collapsed and capped. */
  text: string;
}

// ---------------------------------------------------------------------------
// Migration operations — every source is read into these, then replayed.
// Table names are as written (`schema.name` or `name`), matched case-insensitively.
// ---------------------------------------------------------------------------

export type DbOp =
  | { op: "createTable"; table: string; columns: DbColumn[]; pk: string[]; fks: DbFk[]; indexes: DbIndex[]; checks: DbCheck[]; ifNotExists?: true; view?: true; line: number }
  | { op: "dropTable"; table: string; view?: true; line: number }
  | { op: "renameTable"; table: string; to: string; line: number }
  | { op: "addColumn"; table: string; column: DbColumn; fk?: DbFk; line: number }
  | { op: "dropColumn"; table: string; column: string; line: number }
  | { op: "alterColumn"; table: string; column: string; type?: string; nullable?: boolean; default?: string | null; line: number }
  | { op: "renameColumn"; table: string; column: string; to: string; line: number }
  | { op: "createIndex"; table: string; index: DbIndex; concurrently?: true; line: number }
  | { op: "dropIndex"; name: string; table?: string; line: number }
  | { op: "addFk"; table: string; fk: DbFk; line: number }
  | { op: "addPk"; table: string; columns: string[]; line: number }
  | { op: "addCheck"; table: string; check: DbCheck; line: number }
  | { op: "dropConstraint"; table: string; name: string; line: number }
  | { op: "createEnum"; name: string; values: string[]; line: number }
  | { op: "alterEnum"; name: string; add?: string[]; rename?: [string, string]; line: number }
  | { op: "dropEnum"; name: string; line: number }
  | { op: "opaque"; text: string; table?: string; line: number };

export interface DbMigration {
  /** Stable across commits: its file, plus the class / revision when one file can't say it alone. */
  id: string;
  name: string;
  file: string;
  line: number;
  tool: DbTool;
  /** Its place in the replay (0-based), or -1 when it couldn't be ordered. */
  order: number;
  ops: DbOp[];
}

export interface Database {
  /** `<tool>:<folder>` (`prisma:prisma`, `django`, `sql:db/migrations`). */
  id: string;
  /** What to call it: its folder or file. */
  name: string;
  dialect?: DbDialect;
  /** Read from the SQL itself rather than declared. */
  dialectGuessed?: true;
  tools: DbTool[];
  sources: DbSourceRef[];
  tables: DbTable[];
  enums: DbEnum[];
  /** In replay order. */
  migrations: DbMigration[];
  opaque: DbOpaque[];
  /** Why some migrations couldn't be ordered (two Alembic heads, a Django cycle, unnumbered files). Shown, never guessed. */
  orderProblems: string[];
}

export type DbUseVia = "model" | "builder" | "sql";

/** A place in the code that reaches a table. */
export interface DbTableUse {
  table: string;
  file: string;
  line: number;
  via: DbUseVia;
  access?: "read" | "write";
  /** The declaration the line sits in (`<file>#<name>`). */
  decl?: string;
}

export interface DbEndpointLink {
  /** The API catalog's endpoint id. */
  endpoint: string;
  /** `GET /orders/{id}`. */
  label: string;
  via: DbUseVia[];
  access?: "read" | "write" | "both";
}

export interface DbSchema {
  databases: Database[];
  /** Where the code reaches tables (capped at {@link MAX_USES}). */
  uses: DbTableUse[];
  /** Per endpoint id: the tables it reaches, any of the three ways. */
  endpointTables: Record<string, Array<{ table: string; via: DbUseVia[]; access?: "read" | "write" | "both" }>>;
  /** Schema files read (for the empty state). */
  files: number;
}

export const MAX_USES = 8000;

export const EMPTY_DB_SCHEMA: DbSchema = { databases: [], uses: [], endpointTables: {}, files: 0 };

// ---------------------------------------------------------------------------
// Facts the parse records per code file (../syntax/db.mjs) — raw syntax.
// ---------------------------------------------------------------------------

/** A value as written (../syntax/db.mjs). */
export type DV =
  | { s: string }
  | { t: string }
  | { n: number }
  | { b: boolean }
  | { nil: true }
  | { id: string }
  | { call: string; args: DV[]; kw?: Record<string, DV> }
  | { chain: Array<{ name: string; args: DV[]; kw?: Record<string, DV> }> }
  | { list: DV[] }
  | { obj: Record<string, DV> }
  | { fn: DV }
  | { x: string };

export interface DbDecoratorFact {
  name: string;
  args: DV[];
  line: number;
}

export interface DbCodeFacts {
  entities?: Array<{
    name: string;
    line: number;
    endLine: number;
    decorators: DbDecoratorFact[];
    extends?: string;
    props: Array<{ name: string; line: number; type?: string; optional?: true; value?: DV; decorators: DbDecoratorFact[] }>;
  }>;
  migrations?: Array<{ name: string; line: number; endLine: number; implements?: string[]; up?: [number, number]; calls: Array<{ m: string; args: DV[]; line: number }> }>;
  tables?: Array<{ local: string; line: number; endLine: number; builder: string; args: DV[]; schema?: string; rest?: string[] }>;
  classes?: Array<{
    name: string;
    line: number;
    endLine: number;
    bases: string[];
    kw?: Record<string, DV>;
    decorators?: string[];
    attrs: Array<{ name: string; line: number; ann?: string; value?: DV }>;
    meta?: Record<string, DV>;
  }>;
  assigns?: Array<{ name: string; line: number; value: DV }>;
  upgrade?: Array<{ m: string; args: DV[]; kw?: Record<string, DV>; line: number; batch?: { table: string; schema?: string } }>;
  uses?: Array<{ k: "delegate" | "builder" | "sql"; name?: string; text?: string; line: number; w?: 1; lit?: 1 }>;
  writes?: number[];
  hints?: DbDialect[];
}

// ---------------------------------------------------------------------------
// A review target's schema change (./compare.ts)
// ---------------------------------------------------------------------------

export type DbTableStatus = "added" | "removed" | "renamed" | "changed";
export type DbColumnStatus = "added" | "removed" | "changed" | "renamed";

export interface DbColumnDelta {
  name: string;
  status: DbColumnStatus;
  before?: DbColumn;
  after?: DbColumn;
  /** For renamed: the old name. */
  from?: string;
  /** What changed on a `changed` column. */
  aspects?: Array<"type" | "nullable" | "default" | "unique" | "primary">;
}

export interface DbTableChange {
  /** Head id; the base id for a removed table. */
  id: string;
  status: DbTableStatus;
  /** As it is at the head (at the base when removed). */
  table: DbTable;
  before?: DbTable;
  /** For renamed: the base name (and how it was found). */
  renamedFrom?: string;
  renamedVia?: "migration" | "matching columns";
  columns: DbColumnDelta[];
  indexes: { added: DbIndex[]; removed: DbIndex[] };
  fks: { added: DbFk[]; removed: DbFk[] };
  checks: { added: DbCheck[]; removed: DbCheck[] };
  /** Ids of the PR's migrations that touch it. */
  migrations: string[];
  /** Keys of the findings about it. */
  findings?: string[];
}

export interface DbEnumChange {
  id: string;
  status: "added" | "removed" | "changed";
  name: string;
  added: string[];
  removed: string[];
}

export type DbFindingRule =
  | "drop-table"
  | "drop-column"
  | "not-null-no-default"
  | "type-narrowing"
  | "rename-column"
  | "rename-table"
  | "index-not-concurrent"
  | "fk-no-index";

export const DESTRUCTIVE_RULES: ReadonlySet<DbFindingRule> = new Set(["drop-table", "drop-column"]);

/** A certain finding, no model call (DESIGN.md §6.13 §5). The target-graph job stores them as `category: "schema"`. */
export interface DbFinding {
  /** Stable for one target: rule + table (+ column) + migration. */
  key: string;
  rule: DbFindingRule;
  table: string;
  column?: string;
  migration: string;
  file: string;
  line?: number;
  summary: string;
  rationale: string;
}

/** Drift the PR introduces: "model changed, no migration" and the reverse. */
export interface DbDriftDelta {
  table: string;
  tableName: string;
  drift: DbDrift;
}

export interface DbChange {
  tables: DbTableChange[];
  enums: DbEnumChange[];
  /** The migrations the PR adds, in replay order. */
  migrations: DbMigration[];
  drift: DbDriftDelta[];
  findings: DbFinding[];
  counts: { added: number; removed: number; renamed: number; changed: number; migrations: number; findings: number; destructive: number };
  /** Tables at the head — for "N of M". */
  total: number;
}
