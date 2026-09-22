/**
 * Turn a JVM file's explicit imports plus its lexical references into the
 * `RawImport` list the graph builder resolves.
 *
 * Java and Kotlin need no `import` for a type of the *same package*, nor for one
 * of a package brought in with `import x.y.*` (the type is used bare). To get real
 * coupling we therefore emit, for every capitalised name a file uses that is not
 * explicitly imported and not declared in the file itself, **speculative**
 * candidates `<samePackage>.<Name>` and `<wildcardPackage>.<Name>`. The graph
 * builder drops a speculative import unless it resolves to a name some file really
 * declares (the same "speculative, dropped unless resolved" rule the Python
 * analyzer uses for `from pkg import name`), so a candidate costs one map lookup
 * and never pollutes the IR or the external packages.
 *
 * The surviving entries use `kind: "import"` but are *type references*, not
 * literal imports: their `raw` is a synthesized fully-qualified name.
 */
import type { RawImport } from "../../analyzer";
import type { References } from "./tokenize";

/** One `import` statement, language-neutral. */
export interface ExplicitImport {
  /** Dotted name without the trailing `.*`. */
  name: string;
  wildcard: boolean;
  /** Java `import static` (a wildcard of that form names class members, not a package). */
  isStatic?: boolean;
  /** Kotlin `import a.b.C as D`. */
  alias?: string;
}

/**
 * `java.lang` (and Kotlin default-import) names that would be ambiguous with any
 * package pulled in by a wildcard import; never used to build a *wildcard*
 * candidate. Same-package candidates are unaffected on purpose: a class of the
 * current package legitimately shadows `java.lang`.
 */
const IMPLICIT_NAMES = new Set([
  "Object", "String", "Integer", "Long", "Short", "Byte", "Double", "Float", "Boolean",
  "Character", "Number", "Math", "System", "Thread", "Runnable", "Exception",
  "RuntimeException", "Error", "Throwable", "Class", "Enum", "Record", "Iterable",
  "Comparable", "Override", "Deprecated", "SuppressWarnings", "FunctionalInterface",
  "Void", "StringBuilder", "CharSequence", "Process", "Runtime",
  // Kotlin
  "Any", "Unit", "Int", "Nothing", "Array", "List", "Map", "Set", "Pair", "Triple",
  "Sequence", "Result", "Lazy", "Regex", "Collection", "MutableList", "MutableMap",
  "MutableSet", "Char", "UInt", "ULong", "Function",
]);

const qualify = (pkg: string, name: string): string => (pkg === "" ? name : `${pkg}.${name}`);

export interface JvmFileFacts {
  /** The file's own package, `""` for the default package. */
  pkg: string;
  imports: ExplicitImport[];
  /** Type names declared anywhere in the file (top level and nested). */
  localTypes: ReadonlySet<string>;
  /** Kotlin: function/property names declared anywhere in the file. */
  localMembers?: ReadonlySet<string>;
  references: References;
  /** Also consider called lower-case names (Kotlin top-level functions). */
  includeCalls: boolean;
}

export function buildJvmImports(facts: JvmFileFacts): RawImport[] {
  const out: RawImport[] = [];
  const explicitRaws = new Set<string>();
  const importedNames = new Set<string>();
  const wildcardPackages: string[] = [];

  for (const imp of facts.imports) {
    const raw = imp.wildcard ? `${imp.name}.*` : imp.name;
    explicitRaws.add(raw);
    out.push({ raw, kind: "import" });
    if (imp.wildcard) {
      if (!imp.isStatic) wildcardPackages.push(imp.name);
    } else {
      importedNames.add(imp.alias ?? imp.name.slice(imp.name.lastIndexOf(".") + 1));
    }
  }

  const seen = new Set<string>();
  const speculate = (raw: string): void => {
    if (explicitRaws.has(raw) || seen.has(raw)) return;
    seen.add(raw);
    out.push({ raw, kind: "import", speculative: true });
  };

  for (const name of facts.references.simple) {
    if (importedNames.has(name) || facts.localTypes.has(name)) continue;
    speculate(qualify(facts.pkg, name));
    if (IMPLICIT_NAMES.has(name)) continue;
    for (const wildcard of wildcardPackages) speculate(`${wildcard}.${name}`);
  }

  for (const qualified of facts.references.qualified) speculate(qualified);

  if (facts.includeCalls) {
    for (const name of facts.references.calls) {
      if (importedNames.has(name) || facts.localMembers?.has(name)) continue;
      speculate(qualify(facts.pkg, name));
      for (const wildcard of wildcardPackages) speculate(`${wildcard}.${name}`);
    }
  }
  return out;
}

/** Fully qualified name of a top-level declaration. */
export function fqn(pkg: string, name: string): string {
  return qualify(pkg, name);
}
