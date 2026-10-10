/**
 * SQL in code (DESIGN.md §6.13 §1): DDL the app keeps in its own string or
 * template literals — a `MIGRATIONS` array of `CREATE TABLE` / `ALTER TABLE`
 * statements run with `db.exec(MIGRATIONS[version])`, or a `CREATE TABLE IF
 * NOT EXISTS` run at startup.
 *
 * Only what is certain about the order is used:
 *   - the elements of one array / list literal are migrations, one each, in
 *     element order (`lib/db/schema.ts #3` is the third element);
 *   - other DDL literals of a file are a schema-file-like source, replayed
 *     in line order;
 *   - DDL spread over several files outside any array has no order between
 *     the files: each file is replayed on its own and the problem is shown.
 * A statement with a template hole (`${…}`) is kept opaque, never guessed.
 * Test and fixture files never count (their DDL builds throwaway databases),
 * and neither do files another tool already reads as migrations.
 */
import { baseOf, migration, type DeclSet, type MigrationSet, type TableDecl } from "../common";
import { SchemaState } from "../replay";
import { guessDialect, parseStatement, splitSqlStatements } from "../sql";
import type { DbCodeFacts, DbDialect, DbOp } from "../types";

/** Paths whose DDL builds a test's or an example's database, not the app's. */
export const TEST_PATH =
  /(^|\/)(__tests__|__fixtures__|__mocks__|tests?|fixtures?|testdata|test-data|spec|specs|e2e|examples?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)smoke-test[^/]*$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$|(^|\/)conftest\.py$|Tests?\.(java|kt)$/i;

const collapse = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
};

/** One literal's statements; one with a template hole is opaque. */
export function ddlOps(text: string, line: number): DbOp[] {
  const ops: DbOp[] = [];
  for (const st of splitSqlStatements(text, line)) {
    if (st.text.includes("${")) {
      ops.push({ op: "opaque", text: collapse(st.text), line: st.line });
      continue;
    }
    try {
      ops.push(...parseStatement(st));
    } catch {
      ops.push({ op: "opaque", text: collapse(st.text), line: st.line });
    }
  }
  return ops;
}

function fileDialect(facts: DbCodeFacts, texts: readonly string[]): { dialect?: DbDialect; dialectGuessed?: true } {
  const hints = [...new Set(facts.hints ?? [])];
  if (hints.length === 1) return { dialect: hints[0] };
  const guessed = guessDialect(texts);
  return guessed ? { dialect: guessed, dialectGuessed: true } : {};
}

export interface SqlInCodeOutput {
  migrations: MigrationSet[];
  /** Per file, its DDL outside arrays, as a declarative source. */
  decls: DeclSet[];
  /** Set when loose DDL is spread over several files. */
  problem?: string;
}

export function resolveSqlInCode(code: ReadonlyArray<{ file: string; facts: DbCodeFacts }>, exclude: ReadonlySet<string>): SqlInCodeOutput {
  const migrations: MigrationSet[] = [];
  const decls: DeclSet[] = [];
  for (const { file, facts } of code) {
    if (!facts.ddl?.length || exclude.has(file) || TEST_PATH.test(file)) continue;
    const groups = new Map<string, NonNullable<DbCodeFacts["ddl"]>>();
    for (const d of facts.ddl) if (d.group) (groups.get(d.group) ?? groups.set(d.group, []).get(d.group)!).push(d);
    const arrays = [...groups.values()].filter((g) => g.length >= 2);
    const inArray = new Set(arrays.flat());
    const texts = facts.ddl.map((d) => d.text);
    const dialect = fileDialect(facts, texts);
    arrays.forEach((elements, n) => {
      const ordered = [...elements].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      migrations.push({
        tool: "sql-in-code",
        root: file,
        family: "sql",
        migrations: ordered.map((d, i) => ({
          ...migration(`${file}#${d.index}`, `${file} #${d.index}`, file, d.line, "sql-in-code", ddlOps(d.text, d.line)),
          order: i,
        })),
        problems: [],
        ...dialect,
        ...(arrays.length > 1 ? { root: `${file}#${n + 1}` } : {}),
      });
    });
    const loose = facts.ddl.filter((d) => !inArray.has(d)).sort((a, b) => a.line - b.line);
    if (loose.length === 0) continue;
    const state = new SchemaState("schema", false);
    for (const d of loose) for (const op of ddlOps(d.text, d.line)) state.apply(op, { id: file, name: baseOf(file), file });
    const tables: TableDecl[] = [...state.tables.values()].map((t) => ({
      name: t.schema ? `${t.schema}.${t.name}` : t.name,
      columns: t.columns,
      pk: t.pk,
      fks: t.fks,
      indexes: t.indexes,
      checks: t.checks,
      file,
      line: t.definedAt.line,
      ...(t.view ? { view: true as const } : {}),
    }));
    if (tables.length === 0 && state.enums.size === 0) continue;
    decls.push({
      tool: "sql-in-code",
      kind: "schema",
      root: file,
      files: [file],
      tables,
      enums: [...state.enums.values()].map((e) => ({ name: e.schema ? `${e.schema}.${e.name}` : e.name, values: e.values, file, line: e.line })),
      ...(dialect.dialect && !dialect.dialectGuessed ? { dialect: dialect.dialect } : {}),
    });
  }
  // Loose DDL in several files (no migration array of their own): no order between the files.
  const standalone = decls.filter((d) => !migrations.some((m) => m.root === d.root || m.root.startsWith(`${d.root}#`)));
  const problem =
    standalone.length > 1
      ? `DDL in ${standalone.length} files outside any array (${standalone.map((d) => d.root).slice(0, 4).join(", ")}${standalone.length > 4 ? ", …" : ""}): each file is replayed in line order, but the order between the files is unknown — a statement on a table another file defines is kept as not modelled.`
      : undefined;
  return { migrations, decls, ...(problem ? { problem } : {}) };
}
