/**
 * Shared pieces of the schema resolvers (./sources/*): reading `DV` values
 * (../syntax/db.mjs), naming conventions, and the shapes resolvers hand to
 * ./catalog.ts.
 */
import type { DbCheck, DbColumn, DbDialect, DbFk, DbIndex, DbMigration, DbModelRef, DbOp, DbSourceKind, DbTool, DV } from "./types";

/** A table as a declarative source (schema file, model) states it. */
export interface TableDecl {
  /** As named, `schema.name` or `name`. */
  name: string;
  columns: DbColumn[];
  pk: string[];
  fks: DbFk[];
  indexes: DbIndex[];
  checks: DbCheck[];
  file: string;
  line: number;
  model?: DbModelRef;
  view?: true;
  /** Model attribute → column name, for drift and the review. */
  fields?: Array<{ field: string; column: string; line?: number }>;
  /** Model attributes that don't map to a column of their own (relations). */
  relations?: string[];
  /** The framework doesn't manage the table (Django `managed = False`): no migration is expected for it. */
  unmanaged?: true;
}

/** A declarative source: a schema file's tables or a set of models. */
export interface DeclSet {
  tool: DbTool;
  kind: Exclude<DbSourceKind, "migration">;
  /** The folder (models) or file (schema) it belongs to, for matching it to a database. */
  root: string;
  files: string[];
  tables: TableDecl[];
  enums: Array<{ name: string; values: string[]; file: string; line: number }>;
  dialect?: DbDialect;
  /** Tables the source declares the whole schema of (Prisma, Drizzle): drift both ways. */
  complete?: boolean;
}

/** A set of migrations (one folder / chain) in replay order. */
export interface MigrationSet {
  tool: DbTool;
  root: string;
  migrations: DbMigration[];
  problems: string[];
  dialect?: DbDialect;
  dialectGuessed?: true;
  /** For matching declarative sources: the tool family it serves. */
  family: string;
}

export function str(v: DV | undefined): string | undefined {
  if (!v) return undefined;
  if ("s" in v) return v.s;
  return undefined;
}

export function num(v: DV | undefined): number | undefined {
  return v && "n" in v ? v.n : undefined;
}

export function bool(v: DV | undefined): boolean | undefined {
  return v && "b" in v ? v.b : undefined;
}

export function isNil(v: DV | undefined): boolean {
  return Boolean(v && "nil" in v);
}

/** A name as written: an identifier/path, or a string. */
export function nameOf(v: DV | undefined): string | undefined {
  if (!v) return undefined;
  if ("id" in v) return v.id;
  if ("s" in v) return v.s;
  return undefined;
}

export function list(v: DV | undefined): DV[] {
  return v && "list" in v ? v.list : [];
}

export function obj(v: DV | undefined): Record<string, DV> {
  return v && "obj" in v ? v.obj : {};
}

/** `{ call }` or a one-step chain, as name + args + kw. */
export function asCall(v: DV | undefined): { name: string; args: DV[]; kw: Record<string, DV> } | undefined {
  if (!v) return undefined;
  if ("call" in v) return { name: v.call, args: v.args, kw: v.kw ?? {} };
  if ("chain" in v && v.chain.length > 0) return { name: v.chain[0].name, args: v.chain[0].args, kw: v.chain[0].kw ?? {} };
  return undefined;
}

/** The last segment of a dotted name: `models.CharField` → `CharField`. */
export const last = (name: string) => name.slice(name.lastIndexOf(".") + 1);

/** A literal value as SQL-ish default text. */
export function literalText(v: DV | undefined): string | undefined {
  if (!v) return undefined;
  if ("s" in v) return `'${v.s}'`;
  if ("n" in v) return String(v.n);
  if ("b" in v) return v.b ? "true" : "false";
  if ("nil" in v) return "NULL";
  if ("id" in v) return v.id;
  if ("call" in v) return `${v.call}()`;
  if ("chain" in v) return v.chain.map((s) => `${s.name}()`).join(".");
  if ("x" in v) return v.x;
  if ("t" in v) return v.t;
  return undefined;
}

/** `UserProfile` → `user_profile`. */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The number of leading path segments two paths share. */
export function sharedDepth(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

export function emptyTable(name: string, file: string, line: number): TableDecl {
  return { name, columns: [], pk: [], fks: [], indexes: [], checks: [], file, line };
}

export function column(name: string, type: string, nullable: boolean, source: DbSourceKind, extra: Partial<DbColumn> = {}): DbColumn {
  return { name, type, nullable, source, ...extra };
}

export function migration(id: string, name: string, file: string, line: number, tool: DbTool, ops: DbOp[]): DbMigration {
  return { id, name, file, line, tool, order: -1, ops };
}

/** Kahn's topological sort; a node in a cycle is left out and reported. Ties go by `key`. */
export function topoSort<T>(nodes: T[], key: (n: T) => string, deps: (n: T) => string[]): { order: T[]; cyclic: T[] } {
  const byKey = new Map(nodes.map((n) => [key(n), n]));
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    const k = key(n);
    indegree.set(k, indegree.get(k) ?? 0);
    for (const d of new Set(deps(n))) {
      if (!byKey.has(d) || d === k) continue;
      indegree.set(k, (indegree.get(k) ?? 0) + 1);
      (children.get(d) ?? children.set(d, []).get(d)!).push(k);
    }
  }
  const ready = [...indegree].filter(([, d]) => d === 0).map(([k]) => k).sort();
  const order: T[] = [];
  while (ready.length) {
    const k = ready.shift()!;
    order.push(byKey.get(k)!);
    for (const c of children.get(k) ?? []) {
      const d = (indegree.get(c) ?? 0) - 1;
      indegree.set(c, d);
      if (d === 0) {
        // Keep `ready` sorted so the order is deterministic.
        const at = ready.findIndex((r) => r > c);
        if (at < 0) ready.push(c);
        else ready.splice(at, 0, c);
      }
    }
  }
  const placed = new Set(order.map(key));
  return { order, cyclic: nodes.filter((n) => !placed.has(key(n))) };
}
