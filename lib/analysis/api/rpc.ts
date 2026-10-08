/**
 * tRPC routers (`router({ user: userRouter, health: publicProcedure.query(…) })`,
 * nested and imported sub-routers followed) and schema-first GraphQL (SDL in
 * `.graphql` files and `gql` templates, linked to `{ Query: { … } }`
 * resolver maps). Code-first GraphQL resolvers are in ./decorated.ts.
 */
import type { TrpcEntryFact } from "../ir";
import { parseTsFields, shapeOf, splitTop, type ApiContext, type PartialEndpoint } from "./context";
import type { ApiField, ApiHandler, ApiParam, ApiShape } from "./types";

const PLAIN_PROCEDURE = /^(t\.)?(publicProcedure|procedure|baseProcedure)$/;

function trpcShape(ctx: ApiContext, file: string, text: string | undefined): ApiShape | undefined {
  if (!text) return undefined;
  if (/\bz\.object\(/.test(text)) {
    const fields = parseTsFields(text);
    return { type: text.length > 80 ? "z.object({…})" : text, ...(fields ? { fields } : {}), source: "static" };
  }
  if (/^z\.\w+\(/.test(text)) return { type: text, source: "static" };
  return shapeOf(ctx, file, text);
}

export function resolveTrpc(ctx: ApiContext): PartialEndpoint[] {
  const routers = new Map<string, { file: string; entries: TrpcEntryFact[] }>();
  for (const entry of ctx.files.values()) {
    for (const r of entry.routes.trpc ?? []) routers.set(r.local ? `${entry.file}#${r.local}` : `${entry.file}@${r.line}`, { file: entry.file, entries: r.entries });
  }
  if (routers.size === 0) return [];

  const refTarget = (file: string, ref: string): string | undefined => {
    const hit = ctx.lookup(file, ref);
    if (hit && routers.has(`${hit.file}#${hit.name}`)) return `${hit.file}#${hit.name}`;
    const [head, ...rest] = ref.split(".");
    const sourceFile = rest.length ? ctx.moduleOf(file, head) : undefined;
    return sourceFile && routers.has(`${sourceFile}#${rest.join(".")}`) ? `${sourceFile}#${rest.join(".")}` : undefined;
  };

  const referenced = new Set<string>();
  const collectRefs = (file: string, entries: TrpcEntryFact[]) => {
    for (const e of entries) {
      if (e.ref) {
        const target = refTarget(file, e.ref);
        if (target) referenced.add(target);
      }
      if (e.nested) collectRefs(file, e.nested);
    }
  };
  for (const r of routers.values()) collectRefs(r.file, r.entries);

  const out: PartialEndpoint[] = [];
  const emit = (file: string, entries: TrpcEntryFact[], prefix: string[], depth: number, seen: Set<string>) => {
    for (const e of entries) {
      const path = [...prefix, e.key];
      if (e.nested) {
        emit(file, e.nested, path, depth + 1, seen);
        continue;
      }
      if (e.ref) {
        const target = refTarget(file, e.ref);
        if (!target || seen.has(target) || depth > 8) continue;
        const r = routers.get(target)!;
        emit(r.file, r.entries, path, depth + 1, new Set(seen).add(target));
        continue;
      }
      if (!e.op) continue;
      const range = e.fn ?? [e.line, e.endLine ?? e.line];
      const handler: ApiHandler = { file, startLine: range[0], endLine: range[1], name: path.join("."), ...(e.hash ? { hash: e.hash } : {}) };
      const request = trpcShape(ctx, file, e.input);
      const response = trpcShape(ctx, file, e.output);
      const params: ApiParam[] = request?.fields?.map((f) => ({ name: f.name, in: "input" as const, type: f.type, required: f.required })) ?? [];
      out.push({
        kind: "trpc",
        method: e.op.toUpperCase(),
        path: path.join("."),
        framework: "tRPC",
        group: path.length > 1 ? path[0] : "(root)",
        handler,
        params,
        ...(request ? { request } : {}),
        ...(response ? { response } : {}),
        auth: [...(e.base && !PLAIN_PROCEDURE.test(e.base) ? [e.base] : []), ...(e.middleware ?? [])],
      });
    }
  };
  for (const [id, r] of routers) if (!referenced.has(id)) emit(r.file, r.entries, [], 0, new Set([id]));
  return out;
}

// ---------------------------------------------------------------------------
// GraphQL SDL
// ---------------------------------------------------------------------------

const ROOT_TYPES: Record<string, string> = { Query: "QUERY", Mutation: "MUTATION", Subscription: "SUBSCRIPTION" };

function stripSdl(text: string): string {
  return text
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, " ");
}

interface SdlField {
  name: string;
  args: ApiParam[];
  type: string;
}

/** Every object type's fields, root types included. */
function parseSdl(text: string): Map<string, SdlField[]> {
  const types = new Map<string, SdlField[]>();
  const clean = stripSdl(text);
  const re = /(?:extend\s+)?(?:type|input|interface)\s+(\w+)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") depth--;
    }
    const body = clean.slice(re.lastIndex, i - 1);
    const fields = types.get(m[1]) ?? [];
    for (const part of splitTop(body, "\n,")) {
      const f = /^(\w+)\s*(?:\(([\s\S]*)\))?\s*:\s*([^@=]+?)\s*(?:=.*)?(?:@[\s\S]*)?$/.exec(part.trim());
      if (!f) continue;
      const args = f[2]
        ? splitTop(f[2], ",\n")
            .map((a) => /^(\w+)\s*:\s*([^=@]+?)\s*(=|@|$)/.exec(a.trim()))
            .filter((a): a is RegExpExecArray => a !== null)
            .map((a): ApiParam => ({ name: a[1], in: "arg", type: a[2].trim(), required: a[2].trim().endsWith("!") }))
        : [];
      fields.push({ name: f[1], args, type: f[3].trim() });
    }
    types.set(m[1], fields);
  }
  return types;
}

const baseType = (type: string) => type.replace(/[[\]!\s]/g, "");

export async function resolveGraphql(ctx: ApiContext): Promise<PartialEndpoint[]> {
  const sources: Array<{ file: string; line: number; text: string }> = [];
  for (const path of ctx.allFiles) {
    if (!/\.(graphql|gql|graphqls)$/.test(path) || /(^|\/)(node_modules|vendor|dist|build)\//.test(path)) continue;
    if (sources.length >= 200) break;
    const text = await ctx.readText(path);
    if (text) sources.push({ file: path, line: 1, text });
  }
  for (const entry of ctx.files.values()) for (const g of entry.routes.gql ?? []) sources.push({ file: entry.file, line: g.line, text: g.text });
  if (sources.length === 0) return [];

  const allTypes = new Map<string, SdlField[]>();
  const rootFields: Array<{ op: string; field: SdlField; file: string; line: number }> = [];
  for (const src of sources) {
    const types = parseSdl(src.text);
    for (const [name, fields] of types) {
      if (ROOT_TYPES[name]) for (const field of fields) rootFields.push({ op: ROOT_TYPES[name], field, file: src.file, line: src.line + (src.text.slice(0, src.text.indexOf(`${field.name}`)).split("\n").length - 1) });
      else allTypes.set(name, [...(allTypes.get(name) ?? []), ...fields]);
    }
  }

  const resolverOf = new Map<string, ApiHandler>();
  for (const entry of ctx.files.values()) {
    for (const r of entry.routes.resolvers ?? []) {
      const key = `${r.type}.${r.field}`;
      if (resolverOf.has(key)) continue;
      const ref = r.ref ? ctx.lookup(entry.file, r.ref) : undefined;
      const decl = ref?.decl;
      resolverOf.set(
        key,
        decl
          ? { file: decl.file, startLine: decl.startLine, endLine: decl.endLine, name: decl.qualified, declId: decl.id, ...(decl.textHash ? { hash: decl.textHash } : {}) }
          : { file: entry.file, startLine: r.line, endLine: r.endLine, name: key, ...(r.hash ? { hash: r.hash } : {}) },
      );
    }
  }

  const fieldsOf = (type: string): ApiField[] | undefined =>
    allTypes.get(baseType(type))?.map((f) => ({ name: f.name, type: f.type, required: f.type.endsWith("!") }));

  return rootFields.map(({ op, field, file, line }) => {
    const opName = op === "QUERY" ? "Query" : op === "MUTATION" ? "Mutation" : "Subscription";
    const handler = resolverOf.get(`${opName}.${field.name}`) ?? { file, startLine: line, endLine: line, name: `${opName}.${field.name} (schema)` };
    const inputArg = field.args.find((a) => allTypes.has(baseType(a.type ?? "")));
    const responseFields = fieldsOf(field.type);
    return {
      kind: "graphql" as const,
      method: op,
      path: field.name,
      framework: "GraphQL",
      group: baseType(field.type),
      handler,
      params: field.args,
      ...(inputArg ? { request: { type: inputArg.type, ...(fieldsOf(inputArg.type!) ? { fields: fieldsOf(inputArg.type!) } : {}), source: "static" as const } } : {}),
      response: { type: field.type, ...(responseFields ? { fields: responseFields } : {}), source: "static" as const },
      auth: [],
    };
  });
}
