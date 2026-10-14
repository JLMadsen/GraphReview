/**
 * The env catalog: every env var name a commit reads, declares or sets, and
 * where (DESIGN.md §6.15). Pure data — built by ./catalog.ts, compared by
 * ./compare.ts, stored as JSON and sent to the browser as is.
 *
 * Values are kept as committed (the user decided the view shows them all);
 * what reaches the model goes through ./secret.ts first (§6.15 §5).
 */

/** Where a set comes from. */
export type EnvSourceKind = "dotenv" | "ci" | "compose" | "framework" | "nomad" | "kubernetes" | "docker";

/** How a declaration is written. */
export type EnvDeclVia = "example" | "t3-env" | "zod" | "envalid" | "pydantic" | "django-environ" | "go-tag";

export interface EnvRead {
  file: string;
  line: number;
  /** A fallback in code (`?? "x"`, `getenv("X", "d")`, `${X:-d}`): the literal, or `…` when it isn't one. */
  fallback?: string;
  /** Non-null asserted, `os.environ["X"]`, or a throw/exit guard on the line. */
  required?: true;
  /** The file runs in the browser (a `"use client"` file or one it imports). */
  client?: true;
  /** Read through `import.meta.env`. */
  meta?: true;
  /** Not code: a Compose or Prisma file reading the host's env. */
  host?: true;
  /** In a test or fixture file (often a fixture string a lexical scan can't tell from code): shown, never a gap. */
  test?: true;
  /** No fallback and nothing in scope gives it a value: whether a schema/example declares it, or only refs might set it. */
  gap?: "undeclared" | "not-set" | "maybe-set";
}

export interface EnvDecl {
  file: string;
  line: number;
  via: EnvDeclVia;
  /** `string`, `url`, `number`, `bool`, … as the schema writes it. */
  type?: string;
  default?: string;
  optional?: true;
  /** The comment right above an example key. */
  description?: string;
  /** Declared in a schema's client section (t3-env `client:`). */
  client?: true;
}

export interface EnvSet {
  /** Stable across commits: `source:file:target:name`. */
  id: string;
  source: EnvSourceKind;
  file: string;
  line: number;
  /** The environment or target column it fills: `default`, `production`, `compose:web`, `ci:deploy`, `nomad:api/web/server`. */
  target: string;
  /** As committed. Absent for a ref. */
  value?: string;
  /** Set by reference: the value lives elsewhere (CI secret store, k8s Secret, a template). Counts as "maybe set". */
  ref?: string;
  /** The value expands another variable (`${OTHER}`). */
  interpolated?: true;
  /** Repo folders whose code it reaches (`""` is the whole repo). */
  scope: string[];
  /** Puts the value in the browser bundle (`next.config` `env`, Vite `define`). */
  client?: true;
}

export type EnvTag =
  | "undeclared" // read without fallback; nothing in scope declares or sets it
  | "not-set" // declared (or has an example) but nothing in the repo gives it a value
  | "set-not-read"
  | "maybe-set" // only refs (CI secrets, k8s Secrets, templates) set it
  | "secret" // secret-looking by name or by a committed value
  | "client" // exposed to the browser
  | "undefined-in-client" // read in client code without the client prefix
  | "platform"; // provided by the runtime (NODE_ENV, PORT, CI, …)

export interface EnvVar {
  name: string;
  reads: EnvRead[];
  decls: EnvDecl[];
  sets: EnvSet[];
  tags: EnvTag[];
  /** Why it is client-exposed, when it is: `NEXT_PUBLIC_ prefix`, `next.config env`, `t3-env client`. */
  clientVia?: string;
  /** Infra resource ids that set it (links into the Infra view). */
  infra: string[];
  /** Prefix group for the list: `DATABASE_*`, or `` when it has none shared with another name. */
  group: string;
}

/** A column of the matrix. */
export interface EnvTarget {
  id: string;
  /** What kind of source fills it; `example` for `.env.example` and friends. */
  kind: EnvSourceKind | "example";
  files: string[];
}

/** An app or package: where a framework config or `.env` file sits. */
export interface EnvScope {
  root: string;
  framework?: "next" | "vite" | "astro" | "sveltekit" | "nuxt";
}

export interface EnvCatalog {
  vars: EnvVar[];
  targets: EnvTarget[];
  scopes: EnvScope[];
  /** Env source files read (for the empty state). */
  files: number;
}

export const EMPTY_ENV_CATALOG: EnvCatalog = { vars: [], targets: [], scopes: [], files: 0 };

// ---------------------------------------------------------------------------
// A review target's env change (./compare.ts)
// ---------------------------------------------------------------------------

export interface EnvCellDelta {
  /** `read`, `declared`, or a target id. */
  where: string;
  before?: string;
  after?: string;
  file?: string;
  line?: number;
}

export interface EnvChangeEntry {
  name: string;
  /** new: nothing at the base reads, declares or sets it; gone: nothing at the head does. */
  status: "new" | "gone" | "changed";
  /** At the head (the base for `gone`). */
  variable: EnvVar;
  deltas: EnvCellDelta[];
  /** Tags the head has that the base didn't. */
  newTags: EnvTag[];
  findings?: string[];
}

export type EnvFindingRule = "undeclared-read" | "secret-to-client" | "committed-secret" | "declaration-removed";

/** A certain finding, no model call (DESIGN.md §6.15 §4). Stored as `category: "env"`. */
export interface EnvFinding {
  key: string;
  rule: EnvFindingRule;
  name: string;
  file: string;
  line?: number;
  assessment: "defect" | "concern";
  summary: string;
  rationale: string;
}

export interface EnvChange {
  changes: EnvChangeEntry[];
  findings: EnvFinding[];
  counts: { new: number; gone: number; changed: number; findings: number };
  /** Names at the head — for "N of M". */
  total: number;
}
