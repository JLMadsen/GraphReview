/**
 * Names across files: which declaration each imported name, reference and
 * call leads to.
 *
 * Input: every file's {@link SymbolFacts} (from `syntax/extract.mjs`, or the
 * Kotlin lexical reader) plus the analyzers' own import resolvers. Output: a
 * {@link SymbolGraph} —
 *
 *   decls          every declaration, with a stable id `<file>#<name>` or
 *                  `<file>#<Class>.<method>`
 *   uses           file F refers to declaration D (through an import, a
 *                  namespace member, or a JVM package), on these lines
 *   calls          declaration A calls declaration B on line N
 *   unresolved     calls that name one of the repo's functions/methods but
 *                  couldn't be tied to one (instance calls, mostly)
 *   deadImports    a file imports a name the module it points at doesn't
 *                  provide any more (followed through re-exports)
 *
 * Re-exports are followed through: `export { x } from`, `export *`, `export
 * * as ns`, Python package `__init__` re-exports and submodules. A module
 * whose exports can't be listed statically (CommonJS, `export =`) resolves
 * to "unknown", never to "dead" — nothing here claims a break it can't see.
 *
 * Java/Kotlin: a simple type name resolves through the file's explicit
 * imports, then its own package, then its wildcard imports. Calls on
 * instances (`repo.save(x)`) can't be resolved without types and are
 * counted, not guessed.
 */
import type { AnalyzerContext, LanguageAnalyzer } from "./analyzer";
import type { DeclFact, FileAnalysis, ImportFact, SymbolFacts } from "./ir";
import { dirOf } from "./paths";

export interface SymbolDecl extends DeclFact {
  /** `<file>#<qualified>`. */
  id: string;
  file: string;
  /** `name`, or `<parent>.<name>` for a method. */
  qualified: string;
}

export interface SymbolUse {
  /** The file that uses it. */
  file: string;
  /** The local name it is used under (`ns.member` for a namespace member). */
  local: string;
  /** Declaration id. */
  target: string;
  /** Lines the name occurs on, import statements excluded. */
  lines: number[];
  typeOnly?: boolean;
}

export interface SymbolCall {
  /** Caller declaration id; `<file>#` for module-level code. */
  from: string;
  /** Callee declaration id. */
  to: string;
  file: string;
  line: number;
}

export interface DeadImport {
  file: string;
  local: string;
  imported: string;
  source: string;
  /** The file the import points at, which no longer provides the name. */
  target: string;
  line: number;
}

export interface SymbolGraph {
  decls: SymbolDecl[];
  uses: SymbolUse[];
  calls: SymbolCall[];
  /** Per caller declaration id: calls naming a repo function/method that couldn't be resolved. */
  unresolved: Record<string, number>;
  deadImports: DeadImport[];
  /** File pairs `from\u0000to` whose imports are all type-only (no runtime dependency). */
  typeOnlyEdges: string[];
}

type Target =
  | { kind: "decl"; id: string }
  | { kind: "module"; file: string }
  | { kind: "external" }
  | { kind: "unknown" }
  | { kind: "dead"; file: string };

const UNKNOWN: Target = { kind: "unknown" };
const EXTERNAL: Target = { kind: "external" };

type Family = "js" | "python" | "jvm";

interface FileIndex {
  file: string;
  family: Family;
  facts: SymbolFacts;
  ids: string[];
  /** Module-level declarations by name. */
  top: Map<string, string>;
  /** Class name → method name → id. */
  methods: Map<string, Map<string, string>>;
  analyzer: LanguageAnalyzer;
}

function familyOf(language: string): Family | undefined {
  if (language === "typescript" || language === "tsx" || language === "javascript") return "js";
  if (language === "python") return "python";
  if (language === "java" || language === "kotlin") return "jvm";
  return undefined;
}

function declId(file: string, decl: DeclFact): string {
  return `${file}#${decl.parent ? `${decl.parent}.${decl.name}` : decl.name}`;
}

export function buildSymbolGraph(
  files: readonly FileAnalysis[],
  ctx: AnalyzerContext,
  analyzerFor: (file: string) => LanguageAnalyzer | undefined,
): SymbolGraph {
  const index = new Map<string, FileIndex>();
  const decls: SymbolDecl[] = [];
  const declById = new Map<string, SymbolDecl>();
  /** Names of every function/method in the repo — an unresolved call naming one of these is worth counting. */
  const callableNames = new Set<string>();

  for (const analysis of files) {
    const facts = analysis.symbols;
    const family = familyOf(analysis.language);
    const analyzer = analyzerFor(analysis.file);
    if (!facts || !family || !analyzer) continue;
    const entry: FileIndex = { file: analysis.file, family, facts, ids: [], top: new Map(), methods: new Map(), analyzer };
    for (const decl of facts.decls) {
      const id = declId(analysis.file, decl);
      entry.ids.push(id);
      if (declById.has(id)) continue; // overloads: the first one stands for the name
      const record: SymbolDecl = { ...decl, id, file: analysis.file, qualified: id.slice(analysis.file.length + 1) };
      decls.push(record);
      declById.set(id, record);
      if (decl.kind === "function" || decl.kind === "method") callableNames.add(decl.name);
      if (decl.parent) {
        let byName = entry.methods.get(decl.parent);
        if (!byName) entry.methods.set(decl.parent, (byName = new Map()));
        if (!byName.has(decl.name)) byName.set(decl.name, id);
      } else if (!entry.top.has(decl.name)) {
        entry.top.set(decl.name, id);
      }
    }
    index.set(analysis.file, entry);
  }

  // --- specifier → file -----------------------------------------------------
  const resolvedCache = new Map<string, string | null>();
  const resolveSource = (entry: FileIndex, source: string): string | undefined => {
    const key = `${entry.file}\u0000${source}`;
    const cached = resolvedCache.get(key);
    if (cached !== undefined) return cached ?? undefined;
    let resolved: string | undefined;
    try {
      resolved = entry.analyzer.resolveImportPath(source, entry.file, ctx);
    } catch {
      resolved = undefined;
    }
    resolvedCache.set(key, resolved ?? null);
    return resolved;
  };
  const isRepoSpecifier = (entry: FileIndex, source: string): boolean =>
    entry.family === "python" ? source.startsWith(".") || resolveSource(entry, source) !== undefined : source.startsWith(".") || source.startsWith("/");

  // --- JVM: fully-qualified name → file ------------------------------------
  const fqnToFile = new Map<string, string>();
  for (const analysis of files) for (const name of analysis.declares ?? []) if (!fqnToFile.has(name)) fqnToFile.set(name, analysis.file);

  const classDecl = (file: string, simple: string): string | undefined => {
    const entry = index.get(file);
    if (!entry) return undefined;
    return entry.top.get(simple) ?? [...entry.top.entries()].find(([name]) => name.endsWith(`.${simple}`))?.[1];
  };

  /** A JVM simple name as seen from `entry`: explicit import, own package, wildcard imports. */
  const jvmLookup = (entry: FileIndex, simple: string): Target => {
    const own = entry.top.get(simple);
    if (own) return { kind: "decl", id: own };
    for (const imp of entry.facts.imports) {
      if (imp.star) continue;
      const binding = imp.bindings.find((b) => b.local === simple);
      if (!binding) continue;
      const file = resolveSource(entry, imp.source);
      if (!file) return EXTERNAL;
      if (imp.isStatic) {
        const owner = imp.source.split(".").slice(-2, -1)[0];
        const method = owner ? index.get(file)?.methods.get(owner)?.get(binding.imported) : undefined;
        return method ? { kind: "decl", id: method } : UNKNOWN;
      }
      const id = classDecl(file, binding.imported) ?? index.get(file)?.top.get(binding.imported);
      return id ? { kind: "decl", id } : UNKNOWN;
    }
    const pkg = entry.facts.pkg ?? "";
    const candidates = [pkg ? `${pkg}.${simple}` : simple, ...entry.facts.imports.filter((i) => i.star).map((i) => `${i.source}.${simple}`)];
    for (const fqn of candidates) {
      const file = fqnToFile.get(fqn);
      if (!file) continue;
      const id = classDecl(file, simple) ?? index.get(file)?.top.get(simple);
      if (id) return { kind: "decl", id };
    }
    return UNKNOWN;
  };

  // --- JS / Python exports ----------------------------------------------------
  const exportMemo = new Map<string, Target>();

  const resolveExport = (file: string, name: string, seen: Set<string>): Target => {
    const key = `${file}\u0000${name}`;
    const memo = exportMemo.get(key);
    if (memo) return memo;
    if (seen.has(key)) return UNKNOWN;
    seen.add(key);
    const result = computeExport(file, name, seen);
    exportMemo.set(key, result);
    return result;
  };

  const computeExport = (file: string, name: string, seen: Set<string>): Target => {
    const entry = index.get(file);
    if (!entry) return UNKNOWN;
    const { facts } = entry;
    if (entry.family === "jvm") {
      const id = entry.top.get(name);
      return id ? { kind: "decl", id } : UNKNOWN;
    }
    if (entry.family === "python") {
      const id = entry.top.get(name);
      if (id) return { kind: "decl", id };
      // A package's submodule (`from pkg import mod`, `from . import mod` in its __init__).
      const dir = /(^|\/)__init__\.pyi?$/.test(file) ? dirOf(file) : null;
      if (dir !== null) {
        const base = dir === "" ? name : `${dir}/${name}`;
        for (const candidate of [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`, `${base}/__init__.pyi`]) {
          if (ctx.files.has(candidate)) return { kind: "module", file: candidate };
        }
      }
      if (facts.imports.some((imp) => imp.bindings.some((b) => b.local === name))) return resolveLocal(entry, name, seen);
      let unsure = facts.decls.some((d) => d.name === "__getattr__");
      for (const imp of facts.imports) {
        if (!imp.star) continue;
        const source = resolveSource(entry, imp.source);
        if (!source) {
          unsure = true;
          continue;
        }
        const target = resolveExport(source, name, seen);
        if (target.kind === "decl" || target.kind === "module") return target;
        if (target.kind !== "dead") unsure = true;
      }
      return unsure ? UNKNOWN : { kind: "dead", file };
    }

    // js
    if (facts.opaqueExports) return UNKNOWN;
    const decl = facts.decls.find((d) => d.exported === name && !d.parent);
    if (decl) return { kind: "decl", id: declId(file, decl) };
    let unsure = false;
    for (const exp of facts.exports) {
      if (exp.star || exp.exported !== name) continue;
      if (exp.from === undefined) return resolveLocal(entry, exp.local ?? name, seen);
      const source = resolveSource(entry, exp.from);
      if (!source) return isRepoSpecifier(entry, exp.from) ? UNKNOWN : EXTERNAL;
      if (exp.imported === "*") return { kind: "module", file: source };
      return resolveExport(source, exp.imported ?? name, seen);
    }
    for (const exp of facts.exports) {
      if (!exp.star || !exp.from || name === "default") continue;
      const source = resolveSource(entry, exp.from);
      if (!source) {
        unsure = true;
        continue;
      }
      const target = resolveExport(source, name, seen);
      if (target.kind === "decl" || target.kind === "module") return target;
      if (target.kind !== "dead") unsure = true;
    }
    return unsure ? UNKNOWN : { kind: "dead", file };
  };

  /** What a name bound at module level in `entry` stands for. */
  const resolveLocal = (entry: FileIndex, local: string, seen: Set<string> = new Set()): Target => {
    if (entry.family === "jvm") return jvmLookup(entry, local);
    const own = entry.top.get(local);
    if (own) return { kind: "decl", id: own };
    for (const imp of entry.facts.imports) {
      const binding = imp.bindings.find((b) => b.local === local);
      if (!binding) continue;
      return resolveBinding(entry, imp, binding.imported, seen);
    }
    if (entry.family === "python") {
      for (const imp of entry.facts.imports) {
        if (!imp.star) continue;
        const source = resolveSource(entry, imp.source);
        if (!source) continue;
        const target = resolveExport(source, local, seen);
        if (target.kind === "decl" || target.kind === "module") return target;
      }
    }
    return UNKNOWN;
  };

  const resolveBinding = (entry: FileIndex, imp: ImportFact, imported: string, seen: Set<string> = new Set()): Target => {
    const source = resolveSource(entry, imp.source);
    if (entry.family === "python" && imported !== "*") {
      if (!source) {
        // `from pkg import mod` where pkg has no __init__: the submodule itself.
        const sep = imp.source.endsWith(".") ? "" : ".";
        const sub = resolveSource(entry, `${imp.source}${sep}${imported}`);
        if (sub) return { kind: "module", file: sub };
        return isRepoSpecifier(entry, imp.source) ? UNKNOWN : EXTERNAL;
      }
      return resolveExport(source, imported, seen);
    }
    if (!source) return isRepoSpecifier(entry, imp.source) ? UNKNOWN : EXTERNAL;
    if (imported === "*") return { kind: "module", file: source };
    if (!index.has(source)) return UNKNOWN; // a file without symbol facts (another language, JSON, …)
    return resolveExport(source, imported, seen);
  };

  // --- uses, dead imports, type-only edges --------------------------------
  const uses: SymbolUse[] = [];
  const deadImports: DeadImport[] = [];
  const runtimeEdges = new Set<string>();
  const typeEdges = new Set<string>();

  for (const entry of index.values()) {
    const { facts, file } = entry;
    const importLines = new Set<number>();
    for (const imp of facts.imports) for (let l = imp.startLine; l <= imp.endLine; l++) importLines.add(l);
    const linesOf = (lines: readonly number[] | undefined) => (lines ?? []).filter((l) => !importLines.has(l));

    for (const imp of facts.imports) {
      const source = resolveSource(entry, imp.source);
      if (source) {
        const edgeKey = `${file}\u0000${source}`;
        if (imp.typeOnly) typeEdges.add(edgeKey);
        else runtimeEdges.add(edgeKey);
      }
      if (entry.family === "jvm") continue;
      for (const binding of imp.bindings) {
        const target = resolveBinding(entry, imp, binding.imported);
        const typeOnly = imp.typeOnly || binding.typeOnly;
        if (target.kind === "decl") {
          uses.push({ file, local: binding.local, target: target.id, lines: linesOf(facts.refs[binding.local]), ...(typeOnly ? { typeOnly } : {}) });
        } else if (target.kind === "module") {
          const prefix = `${binding.local}.`;
          for (const [key, lines] of Object.entries(facts.members)) {
            if (!key.startsWith(prefix)) continue;
            const member = resolveExport(target.file, key.slice(prefix.length), new Set());
            if (member.kind === "decl") uses.push({ file, local: key, target: member.id, lines: linesOf(lines) });
          }
        } else if (target.kind === "dead") {
          deadImports.push({ file, local: binding.local, imported: binding.imported, source: imp.source, target: target.file, line: imp.startLine });
        }
      }
    }

    if (entry.family === "jvm") {
      // Types (and statically imported members) used by simple name.
      for (const [name, lines] of Object.entries(facts.refs)) {
        if (entry.top.has(name)) continue;
        const bound = facts.imports.some((imp) => imp.bindings.some((b) => b.local === name));
        if (!bound && !/^[A-Z]/.test(name)) continue;
        const target = jvmLookup(entry, name);
        if (target.kind === "decl" && !target.id.startsWith(`${file}#`)) uses.push({ file, local: name, target: target.id, lines: linesOf(lines) });
      }
    }
  }

  // --- calls ---------------------------------------------------------------
  const calls: SymbolCall[] = [];
  const unresolved: Record<string, number> = {};

  const methodOf = (classId: string, method: string): string | undefined => {
    const decl = declById.get(classId);
    if (!decl) return undefined;
    return index.get(decl.file)?.methods.get(decl.qualified)?.get(method);
  };

  for (const entry of index.values()) {
    const { facts, file } = entry;
    for (const call of facts.calls) {
      const fromDecl = call.inDecl >= 0 ? facts.decls[call.inDecl] : undefined;
      const from = fromDecl ? declId(file, fromDecl) : `${file}#`;
      const enclosingClass = fromDecl ? (fromDecl.parent ?? (fromDecl.kind === "class" ? fromDecl.name : undefined)) : undefined;
      let to: string | undefined;

      if (call.callee === null || call.object === "?") {
        to = undefined;
      } else if (call.object === "this") {
        if (enclosingClass) to = entry.methods.get(enclosingClass)?.get(call.callee);
      } else if (call.object !== undefined) {
        const objectTarget = resolveLocal(entry, call.object);
        if (objectTarget.kind === "module") {
          const member = resolveExport(objectTarget.file, call.callee, new Set());
          if (member.kind === "decl") to = member.id;
        } else if (objectTarget.kind === "decl") {
          // A class's static member: `Util.format()`.
          to = methodOf(objectTarget.id, call.callee);
        }
      } else {
        // A plain name: a method of the enclosing class (JVM, implicit `this`),
        // a module-level declaration, or an import.
        if (entry.family === "jvm" && enclosingClass) to = entry.methods.get(enclosingClass)?.get(call.callee);
        if (!to) {
          const target = resolveLocal(entry, call.callee);
          if (target.kind === "decl") {
            const decl = declById.get(target.id);
            // `new Foo()` / `Foo(…)` on a class: its constructor if it has one.
            to = decl?.kind === "class" ? (methodOf(target.id, "constructor") ?? methodOf(target.id, "<init>") ?? methodOf(target.id, "__init__") ?? target.id) : target.id;
          }
        }
      }

      if (to && to !== from) calls.push({ from, to, file, line: call.line });
      else if (!to && call.callee !== null && callableNames.has(call.callee)) unresolved[from] = (unresolved[from] ?? 0) + 1;
    }
  }

  const typeOnlyEdges = [...typeEdges].filter((key) => !runtimeEdges.has(key));
  return { decls, uses, calls, unresolved, deadImports, typeOnlyEdges };
}
