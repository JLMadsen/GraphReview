/**
 * Common intermediate representation emitted by every `LanguageAnalyzer`.
 * The graph builder only ever sees this shape, never
 * language-specific syntax trees.
 */

/** A single import/require/dynamic-import site found in a file. */
export interface FileImport {
  /** The raw specifier exactly as written in the source (e.g. `./db/client`, `fastapi`). */
  raw: string;
  /** Repo-relative path (POSIX separators) this specifier resolves to, when resolvable. */
  resolvedPath?: string;
  /**
   * How the dependency was expressed:
   * - `import`  — static ESM `import`/`export … from`, Python `import`/`from … import`
   * - `require` — CommonJS `require()`, TS `import x = require()`
   * - `call`    — dynamic, call-shaped imports (`import("…")`, `importlib.import_module("…")`)
   *
   * JVM note: Java/Kotlin also use `import` for *implicit* references (a class of
   * the same package, or of a wildcard-imported package, used without an import
   * statement). Those entries have a synthesized fully-qualified `raw`
   * (`com.acme.util.Strings`) that never appears literally in the source, and
   * exist only when they resolve to a declared repo name.
   */
  kind: "import" | "require" | "call";
}

// ---------------------------------------------------------------------------
// Symbol facts (names) — see ./syntax/extract.mjs, which produces them, and
// ./symbols.ts, which resolves them across files. Lines are 1-based.
// ---------------------------------------------------------------------------

export type DeclKind = "function" | "class" | "method" | "interface" | "type" | "enum" | "const" | "variable" | "module";

/** A module-level declaration, or a method of a module-level class. */
export interface DeclFact {
  /** The declared name; Java nested types are dotted (`Outer.Inner`). */
  name: string;
  kind: DeclKind;
  /** The enclosing class, for a method. */
  parent?: string;
  /** The name it is exported under (`default` included), or `null` when it isn't. */
  exported: string | null;
  startLine: number;
  endLine: number;
  /**
   * What callers depend on: a function's text up to its body, a type's or
   * interface's whole text, a constant's declaration. Whitespace collapsed.
   */
  signature: string;
  /** Fingerprint of the declaration's whole text (whitespace collapsed): equal text, equal hash. */
  textHash?: string;
}

/** One name an import statement binds. `imported` is `default`, `*` (the whole module) or a name. */
export interface BindingFact {
  imported: string;
  local: string;
  typeOnly?: boolean;
}

export interface ImportFact {
  /** The specifier as written (`./a`, `pkg.mod`, `com.acme.Foo`). */
  source: string;
  bindings: BindingFact[];
  typeOnly: boolean;
  startLine: number;
  endLine: number;
  kind: FileImport["kind"];
  /** `from x import *` (Python), `import a.b.*` (Java). */
  star?: boolean;
  /** Java `import static`. */
  isStatic?: boolean;
}

/** A JS/TS export that isn't a declaration's own `export` keyword. */
export interface ExportFact {
  /** `export { local as exported }`. */
  local?: string;
  exported: string;
  /** Re-exports: `export { imported as exported } from "from"`, `export * from "from"`. */
  from?: string;
  imported?: string;
  star?: boolean;
  line: number;
}

export interface CallFact {
  /** The called name; `null` when it isn't a plain name (`f()()`, `a[b]()`). */
  callee: string | null;
  /** `object.callee()`: the object's name, `this` (`this`/`self`/`cls`), or `?` when it is an expression. */
  object?: string;
  line: number;
  /** Index into `decls` of the declaration the call sits in; `-1` for module level. */
  inDecl: number;
  kind: "call" | "new";
}

export interface SymbolFacts {
  decls: DeclFact[];
  imports: ImportFact[];
  exports: ExportFact[];
  /** Lines each identifier occurs on. */
  refs: Record<string, number[]>;
  /** Lines each `object.member` access occurs on, keyed `object.member`. */
  members: Record<string, number[]>;
  calls: CallFact[];
  /** CommonJS / `export =`: the exported names can't be listed statically. */
  opaqueExports?: boolean;
  /** Java package. */
  pkg?: string;
  /** Python `__all__`. */
  all?: string[];
  /** Raw route declarations (./syntax/routes.mjs), resolved into endpoints by ./api/. */
  routes?: RouteFacts;
}

// ---------------------------------------------------------------------------
// Route facts — see ./syntax/routes.mjs. Raw syntax only: which object is a
// router and what a path resolves to is decided across files in ./api/.
// ---------------------------------------------------------------------------

/** A value as written in the source. */
export type Val =
  | { s: string }
  /** A string with holes: `{expr}` where the source interpolates. */
  | { t: string }
  | { id: string }
  /** An inline function: its line range, text fingerprint and head. */
  | { fn: [number, number]; hash: string; sig?: string }
  | { call: string; args: Val[]; kw?: Record<string, Val> }
  | { list: Val[] }
  | { obj: Record<string, Val> }
  | { x: string };

export interface RouteDecorator {
  /** `Get`, `router.get`, `GetMapping`. */
  name: string;
  args: Val[];
  /** Keyword arguments (Python) / annotation pairs (Java). */
  kw?: Record<string, Val>;
}

export interface RouteParamFact {
  name: string;
  type?: string;
  optional?: boolean;
  default?: Val;
  decorators?: RouteDecorator[];
  annotations?: RouteDecorator[];
}

export interface RouteMethodFact {
  name: string;
  line: number;
  endLine: number;
  hash: string;
  decorators?: RouteDecorator[];
  annotations?: RouteDecorator[];
  params: RouteParamFact[];
  returns?: string;
}

export interface RouteClassFact {
  name: string;
  line: number;
  endLine: number;
  decorators?: RouteDecorator[];
  annotations?: RouteDecorator[];
  methods: RouteMethodFact[];
}

/** `obj.m(args)`: a JS route registration or mount, or a Python mount (`include_router`). */
export interface RouteCallFact {
  obj: string;
  m: string;
  args: Val[];
  kw?: Record<string, Val>;
  line: number;
  endLine?: number;
  /** `router.route("/x").get(…)`: the path of the `route()` in the chain. */
  route?: Val;
  /** Index of the declaration it sits in (JS). */
  inDecl?: number;
  /** Name of the function it sits in (Python). */
  inFn?: string;
}

export interface RouterCreateFact {
  local: string;
  /** The factory as written: `express.Router`, `new Hono`, `APIRouter`. */
  callee: string;
  args: Val[];
  kw?: Record<string, Val>;
  line: number;
}

export interface TrpcEntryFact {
  key: string;
  line: number;
  endLine?: number;
  /** A sub-router by name. */
  ref?: string;
  nested?: TrpcEntryFact[];
  op?: "query" | "mutation" | "subscription";
  hash?: string;
  /** The procedure it builds on (`publicProcedure`, `protectedProcedure`). */
  base?: string;
  input?: string;
  output?: string;
  middleware?: string[];
  fn?: [number, number];
}

export interface PyDecoratedFact {
  name: string;
  parent?: string;
  kind?: "class";
  line: number;
  endLine: number;
  hash: string;
  decorators: RouteDecorator[];
  params: RouteParamFact[];
  returns?: string;
}

export interface ModelFieldFact {
  name: string;
  type: string;
  optional?: boolean;
  default?: string;
  /** A field declared by a call (`serializers.CharField(required=False)`). */
  call?: string;
  annotations?: string[];
}

/** A class's fields, for request/response shapes (Pydantic, dataclasses, DTOs, serializers). */
export interface ModelFact {
  name: string;
  line: number;
  bases: string[];
  fields: ModelFieldFact[];
  /** Django REST serializer `class Meta`. */
  meta?: Record<string, Val>;
  /** Class attributes the views need: `serializer_class`, `permission_classes`, `queryset`, … */
  attrs?: Record<string, Val>;
}

export interface RouteFacts {
  calls?: RouteCallFact[];
  creates?: RouterCreateFact[];
  classes?: RouteClassFact[];
  decorated?: PyDecoratedFact[];
  trpc?: Array<{ line: number; local?: string; inDecl?: number; entries: TrpcEntryFact[] }>;
  resolvers?: Array<{ type: string; field: string; line: number; endLine: number; hash?: string; ref?: string }>;
  gql?: Array<{ line: number; text: string }>;
  urlpatterns?: Array<{ line: number; value: Val }>;
  models?: ModelFact[];
  /** The file starts with `"use server"`: every exported async function is a server action. */
  useServer?: true;
  /** Functions with their own `"use server"` directive. */
  actions?: string[];
}

/** One analyzed source file. */
export interface FileAnalysis {
  /** Repo-relative path, POSIX separators. */
  file: string;
  /** Language id reported by the analyzer (e.g. `typescript`, `tsx`, `javascript`, `python`). */
  language: string;
  imports: FileImport[];
  /**
   * Fully-qualified names this file declares, for languages where a file can
   * declare several importable things under a package (JVM: `package` + each
   * top-level type, and for Kotlin also top-level functions, properties and
   * typealiases). Analyzers that have no such notion leave it undefined. Used to
   * build a per-run name -> file index so `import a.b.C` and same-package
   * references resolve without relying on file names.
   */
  declares?: string[];
  /** Physical line count of the file (a trailing newline does not count as an extra line). */
  loc: number;
  /** Names: declarations, named imports/exports, references, calls — for the languages that have them. */
  symbols?: SymbolFacts;
}

/** Count lines the way {@link FileAnalysis.loc} is defined. */
export function countLines(source: string): number {
  if (source.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) lines++;
  }
  // A trailing newline terminates the last line rather than starting a new one.
  if (source.charCodeAt(source.length - 1) === 10) lines--;
  return lines;
}
