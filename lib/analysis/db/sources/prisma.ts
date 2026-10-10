/**
 * Prisma (DESIGN.md §6.13 §1): `schema.prisma` (or a `prisma/schema/`
 * folder of `.prisma` files) as a declarative schema, and
 * `migrations/<timestamp>_<name>/migration.sql` replayed in folder order.
 * The provider comes from the datasource, else `migration_lock.toml`.
 */
import type { DbFileFacts, PrismaBlock, PrismaFacts, PrismaField } from "../read";
import { column, dirOf, migration, type DeclSet, type MigrationSet, type TableDecl } from "../common";
import type { DbColumn, DbDialect, DbFk, DbIndex } from "../types";

export function prismaDialect(provider: string | undefined): DbDialect | undefined {
  if (!provider) return undefined;
  if (/postgres|cockroach/.test(provider)) return "postgresql";
  if (/mysql/.test(provider)) return "mysql";
  if (/sqlite/.test(provider)) return "sqlite";
  if (/sqlserver/.test(provider)) return "sqlserver";
  return undefined;
}

const SCALARS: Record<string, Partial<Record<DbDialect | "default", string>>> = {
  String: { default: "text", mysql: "varchar(191)", sqlserver: "nvarchar(1000)" },
  Int: { default: "integer" },
  BigInt: { default: "bigint" },
  Float: { default: "double precision", mysql: "double", sqlite: "real" },
  Decimal: { default: "numeric(65,30)" },
  Boolean: { default: "boolean" },
  DateTime: { default: "timestamp(3)", mysql: "datetime(3)", sqlite: "datetime" },
  Json: { default: "jsonb", mysql: "json", sqlite: "text" },
  Bytes: { default: "bytea", mysql: "longblob", sqlite: "blob" },
};

/** The argument list of `@name(…)` in an attribute string, or `undefined`. */
function attrArgs(attrs: string, name: string): string | undefined {
  const at = attrs.search(new RegExp(`@${name.replace(".", "\\.")}(?![\\w.])`));
  if (at < 0) return undefined;
  let i = at + name.length + 1;
  if (attrs[i] !== "(") return "";
  let depth = 0;
  const start = i + 1;
  for (; i < attrs.length; i++) {
    if (attrs[i] === "(") depth++;
    else if (attrs[i] === ")") {
      depth--;
      if (depth === 0) return attrs.slice(start, i);
    }
  }
  return attrs.slice(start);
}

const firstString = (args: string | undefined) => (args ? /"([^"]*)"/.exec(args)?.[1] : undefined);
const fieldList = (args: string | undefined, key?: string) => {
  if (!args) return [];
  const m = key ? new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(args) : /^\s*(?:fields\s*:\s*)?\[([^\]]*)\]/.exec(args);
  return m ? m[1].split(",").map((s) => s.trim().replace(/\(.*$/, "")).filter(Boolean) : [];
};

function blockMap(block: PrismaBlock, attr: string): string | undefined {
  const line = block.blockAttrs.find((a) => a.startsWith(`@@${attr}(`));
  return line ? firstString(line.slice(attr.length + 2)) : undefined;
}

/** The tables, enums and dialect of one Prisma schema (one file or a schema folder). */
export function prismaDecls(files: Array<{ file: string; prisma: PrismaFacts }>, providerFallback?: string): DeclSet {
  const provider = files.map((f) => f.prisma.provider).find(Boolean) ?? providerFallback;
  const dialect = prismaDialect(provider);
  const blocks = files.flatMap((f) => f.prisma.blocks.map((b) => ({ block: b, file: f.file })));
  const models = new Map(blocks.filter((b) => b.block.kind === "model" || b.block.kind === "view").map((b) => [b.block.name, b]));
  const enums = new Map(blocks.filter((b) => b.block.kind === "enum").map((b) => [b.block.name, b]));
  const tableName = (name: string) => {
    const m = models.get(name);
    return m ? (blockMap(m.block, "map") ?? name) : name;
  };
  const columnName = (model: PrismaBlock, field: string) => {
    const f = model.fields.find((x) => x.name === field);
    return f ? (firstString(attrArgs(f.attrs, "map")) ?? f.name) : field;
  };
  const typeOf = (f: PrismaField): string | undefined => {
    const native = /@db\.(\w+)(\(([^)]*)\))?/.exec(f.attrs);
    if (native) return `${native[1].toLowerCase()}${native[2] ? `(${native[3].replace(/\s/g, "")})` : ""}${f.list ? "[]" : ""}`;
    if (enums.has(f.type)) return dialect === "mysql" ? `enum(${(enums.get(f.type)!.block.values ?? []).map((v) => `'${v.map ?? v.name}'`).join(",")})` : (blockMap(enums.get(f.type)!.block, "map") ?? f.type);
    const unsupported = /^Unsupported\("([^"]*)"\)$/.exec(f.type);
    if (unsupported) return unsupported[1];
    const s = SCALARS[f.type];
    if (!s) return undefined;
    return `${s[dialect ?? "default"] ?? s.default}${f.list ? "[]" : ""}`;
  };

  const tables: TableDecl[] = [];
  for (const { block, file } of models.values()) {
    const schema = blockMap(block, "schema");
    const name = blockMap(block, "map") ?? block.name;
    const t: TableDecl = {
      name: schema ? `${schema}.${name}` : name,
      columns: [],
      pk: [],
      fks: [],
      indexes: [],
      checks: [],
      file,
      line: block.line,
      model: { tool: "prisma", name: block.name, file, line: block.line },
      fields: [],
      relations: [],
      ...(block.kind === "view" ? { view: true as const } : {}),
    };
    for (const f of block.fields) {
      if (models.has(f.type)) {
        t.relations!.push(f.name);
        const rel = attrArgs(f.attrs, "relation");
        const fields = fieldList(rel, "fields");
        const refs = fieldList(rel, "references");
        if (fields.length) {
          const onDelete = rel ? /onDelete\s*:\s*(\w+)/.exec(rel)?.[1] : undefined;
          const target = models.get(f.type)!;
          const fk: DbFk = {
            columns: fields.map((x) => columnName(block, x)),
            refTable: tableName(f.type),
            refColumns: refs.map((x) => columnName(target.block, x)),
            ...(onDelete ? { onDelete: onDelete.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase() } : {}),
          };
          const fkName = firstString(rel?.match(/map\s*:\s*"[^"]*"/)?.[0]);
          if (fkName) fk.name = fkName;
          t.fks.push(fk);
        }
        continue;
      }
      const type = typeOf(f);
      if (!type) continue; // a composite type (MongoDB) — not a column
      const colName = firstString(attrArgs(f.attrs, "map")) ?? f.name;
      const col: DbColumn = column(colName, type, Boolean(f.optional), "schema");
      if (enums.has(f.type)) col.enum = blockMap(enums.get(f.type)!.block, "map") ?? f.type;
      const def = attrArgs(f.attrs, "default");
      if (def !== undefined) {
        if (/^autoincrement\(\)$/.test(def.trim())) col.generated = "autoincrement";
        else if (/^dbgenerated\(/.test(def.trim())) col.default = firstString(def) ?? def;
        else col.default = def.trim();
      }
      if (/@id\b/.test(f.attrs)) {
        col.primary = true;
        col.nullable = false;
        t.pk = [colName];
      }
      if (/@unique\b/.test(f.attrs)) col.unique = true;
      t.columns.push(col);
      t.fields!.push({ field: f.name, column: colName, line: f.line });
    }
    for (const attr of block.blockAttrs) {
      const m = /^@@(id|unique|index)\((.*)\)\s*$/.exec(attr);
      if (!m) continue;
      const cols = fieldList(m[2]).map((x) => columnName(block, x));
      if (m[1] === "id") {
        t.pk = cols;
        for (const c of t.columns) if (cols.includes(c.name)) {
          c.primary = true;
          c.nullable = false;
        }
        continue;
      }
      const idxName = /map\s*:\s*"([^"]*)"/.exec(m[2])?.[1] ?? /name\s*:\s*"([^"]*)"/.exec(m[2])?.[1];
      const index: DbIndex = { ...(idxName ? { name: idxName } : {}), columns: cols, ...(m[1] === "unique" ? { unique: true as const } : {}) };
      t.indexes.push(index);
    }
    tables.push(t);
  }
  return {
    tool: "prisma",
    kind: "schema",
    root: dirOf(files[0]?.file ?? ""),
    files: files.map((f) => f.file),
    tables,
    enums: [...enums.values()].map(({ block, file }) => ({ name: blockMap(block, "map") ?? block.name, values: (block.values ?? []).map((v) => v.map ?? v.name), file, line: block.line })),
    ...(dialect ? { dialect } : {}),
    complete: true,
  };
}

/** Prisma's schemas and migration folders. Returns the `.sql` files it claimed. */
export function resolvePrisma(dbFiles: ReadonlyArray<{ file: string; facts: DbFileFacts }>): { migrations: MigrationSet[]; decls: DeclSet[]; claimed: Set<string> } {
  const claimed = new Set<string>();
  const locks = new Map<string, string | undefined>();
  for (const f of dbFiles) if (f.facts.kind === "prisma-lock") locks.set(dirOf(f.file), f.facts.provider);

  // Schemas: `.prisma` files grouped by folder (a multi-file schema is one folder).
  const byFolder = new Map<string, Array<{ file: string; prisma: PrismaFacts }>>();
  for (const f of dbFiles) {
    if (f.facts.kind !== "prisma") continue;
    if (!f.facts.prisma.blocks.some((b) => b.kind === "model" || b.kind === "enum" || b.kind === "view") && !f.facts.prisma.provider) continue;
    (byFolder.get(dirOf(f.file)) ?? byFolder.set(dirOf(f.file), []).get(dirOf(f.file))!).push({ file: f.file, prisma: f.facts.prisma });
  }
  // Migrations: `<root>/<name>/migration.sql` where the root is a `migrations` folder with a lock file or timestamped folders.
  const sets = new Map<string, Array<{ file: string; name: string; facts: Extract<DbFileFacts, { kind: "sql" }> }>>();
  for (const f of dbFiles) {
    if (f.facts.kind !== "sql") continue;
    const m = /^(.*\/)?([^/]*migrations)\/([^/]+)\/migration\.sql$/.exec(f.file);
    if (!m) continue;
    const root = `${m[1] ?? ""}${m[2]}`;
    if (!locks.has(root) && !/^\d{8,}_/.test(m[3])) continue;
    claimed.add(f.file);
    (sets.get(root) ?? sets.set(root, []).get(root)!).push({ file: f.file, name: m[3], facts: f.facts });
  }

  const decls: DeclSet[] = [];
  for (const files of byFolder.values()) decls.push(prismaDecls(files, undefined));
  const migrations: MigrationSet[] = [];
  for (const [root, list] of sets) {
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const schema = decls.find((d) => d.root === dirOf(root) || dirOf(d.root) === dirOf(root));
    const dialect = prismaDialect(locks.get(root)) ?? schema?.dialect;
    migrations.push({
      tool: "prisma",
      root,
      family: "prisma",
      migrations: list.map((m, i) => ({ ...migration(m.file, m.name, m.file, 1, "prisma", m.facts.ops), order: i })),
      problems: [],
      ...(dialect ? { dialect } : list.find((m) => m.facts.dialect) ? { dialect: list.find((m) => m.facts.dialect)!.facts.dialect, dialectGuessed: true as const } : {}),
    });
  }
  return { migrations, decls, claimed };
}
