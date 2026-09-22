/**
 * Lexical Kotlin reader: `package`, `import`s (`.*` and `as` aliases), top-level
 * declarations, and the type/function references of a file - read from the token
 * stream of `../jvm/tokenize.ts`, with no grammar.
 *
 * Top-level structure is recovered from brace/paren depth alone: a declaration
 * keyword (`class`, `interface`, `object`, `typealias`, `fun`, `val`, `var`) at
 * brace depth 0 and paren depth 0 declares a top-level name. Everything inside a
 * class body, a function body or a parameter list is deeper and ignored (except
 * that nested/local type and member names are remembered so they are not mistaken
 * for references to other files).
 *
 * Because it never builds a tree it cannot be derailed by formatting (one-line
 * class bodies, missing newlines) and cannot fail on a syntax error: at worst a
 * broken brace hides the declarations after it.
 */
import type { SyntaxFacts } from "../../analyzer";
import { buildJvmImports, fqn, type ExplicitImport } from "../jvm/references";
import { collectReferences, tokenize, type Token } from "../jvm/tokenize";

/** Keywords that start a declaration; a walk back for `private` stops at these. */
const DECLARATION_KEYWORDS = new Set([
  "class", "interface", "object", "typealias", "fun", "val", "var", "import", "package",
]);

const isPunct = (token: Token | undefined, value: string): boolean =>
  token !== undefined && token.k === "p" && token.v === value;

const isId = (token: Token | undefined): token is Token =>
  token !== undefined && token.k === "id";

/** Read `id (. id)*` starting at `i`; returns the segments and the index after them. */
function readDotted(tokens: Token[], start: number): { parts: string[]; next: number } {
  const parts: string[] = [];
  let i = start;
  if (!isId(tokens[i])) return { parts, next: i };
  parts.push(tokens[i].v);
  i++;
  while (isPunct(tokens[i], ".") && isId(tokens[i + 1])) {
    parts.push(tokens[i + 1].v);
    i += 2;
  }
  return { parts, next: i };
}

/** Is the declaration keyword at `index` preceded by a `private` modifier? */
function isPrivate(tokens: Token[], index: number): boolean {
  for (let back = index - 1, steps = 0; back >= 0 && steps < 10; back--, steps++) {
    const token = tokens[back];
    if (!isId(token)) return false;
    if (token.v === "private") return true;
    // `fun interface X`: the `fun` is a modifier of the interface, keep looking.
    if (DECLARATION_KEYWORDS.has(token.v) && !(token.v === "fun" && isId(tokens[back + 1]) && tokens[back + 1].v === "interface")) {
      return false;
    }
  }
  return false;
}

/**
 * Name declared by the `fun` / `val` / `var` keyword at `index`, or `undefined`
 * (anonymous function, destructuring). Handles type parameters and extension
 * receivers: `fun <T> List<T>.second()` declares `second`.
 */
function declaredMemberName(tokens: Token[], index: number): string | undefined {
  let i = index + 1;
  const keyword = tokens[index].v;

  const skipAngles = (): void => {
    if (!isPunct(tokens[i], "<")) return;
    let depth = 0;
    for (; i < tokens.length; i++) {
      if (isPunct(tokens[i], "<")) depth++;
      else if (isPunct(tokens[i], ">")) {
        depth--;
        if (depth === 0) {
          i++;
          return;
        }
      } else if (isPunct(tokens[i], "{") || isPunct(tokens[i], "}") || isPunct(tokens[i], ";")) {
        return; // not really type parameters: give up rather than run away
      }
    }
  };

  skipAngles(); // `fun <T> ...`
  if (!isId(tokens[i])) return undefined; // `fun (` anonymous, `val (a, b)` destructuring
  if (keyword === "fun" && tokens[i].v === "interface") return undefined;

  let name = tokens[i].v;
  i++;
  // Receiver chains: `String.shout`, `List<T>.second`, `Map<K, V>.entriesSorted`.
  for (;;) {
    skipAngles();
    if (isPunct(tokens[i], ".") && isId(tokens[i + 1])) {
      name = tokens[i + 1].v;
      i += 2;
      continue;
    }
    break;
  }
  return name;
}

/** `@file:JvmName("Utils")` - the JVM class name Java callers use for this file. */
function jvmFileName(source: string): string | undefined {
  return /^[ \t]*@file:[ \t]*JvmName\([ \t]*"([A-Za-z_$][\w$]*)"[ \t]*\)/m.exec(source)?.[1];
}

/** `my-utils.kt` -> `My_utilsKt`, the class Kotlin generates for top-level members. */
function defaultFileClass(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
  const cleaned = base.replace(/[^A-Za-z0-9_$]/g, "_");
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}Kt`;
}

export function analyzeKotlinSource(file: string, source: string): SyntaxFacts {
  const tokens = tokenize(source, { kotlin: true });

  let pkg = "";
  let packageSeen = false;
  const imports: ExplicitImport[] = [];
  const topLevel = new Set<string>();
  const localTypes = new Set<string>();
  const localMembers = new Set<string>();
  let hasTopLevelMembers = false;
  const isScript = file.endsWith(".kts");

  let depth = 0;
  let parens = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.k === "p") {
      if (token.v === "{") depth++;
      else if (token.v === "}") depth = Math.max(0, depth - 1);
      else if (token.v === "(") parens++;
      else if (token.v === ")") parens = Math.max(0, parens - 1);
      continue;
    }

    const topLevelPosition = depth === 0 && parens === 0;
    switch (token.v) {
      case "package": {
        if (!topLevelPosition || packageSeen) break;
        const { parts, next } = readDotted(tokens, i + 1);
        if (parts.length > 0) {
          pkg = parts.join(".");
          packageSeen = true;
          i = next - 1;
        }
        break;
      }
      case "import": {
        if (!topLevelPosition) break;
        const { parts, next } = readDotted(tokens, i + 1);
        if (parts.length === 0) break;
        let end = next;
        let wildcard = false;
        let alias: string | undefined;
        if (isPunct(tokens[end], ".") && isPunct(tokens[end + 1], "*")) {
          wildcard = true;
          end += 2;
        } else if (isId(tokens[end]) && tokens[end].v === "as" && isId(tokens[end + 1])) {
          alias = tokens[end + 1].v;
          end += 2;
        }
        imports.push({ name: parts.join("."), wildcard, alias });
        i = end - 1;
        break;
      }
      case "class":
      case "interface":
      case "object":
      case "typealias": {
        if (isPunct(tokens[i - 1], "::")) break; // `Foo::class`
        const nameToken = tokens[i + 1];
        if (!isId(nameToken)) break; // `object : Base()`, `companion object {`
        localTypes.add(nameToken.v);
        if (topLevelPosition && !isPrivate(tokens, i)) topLevel.add(nameToken.v);
        break;
      }
      case "fun":
      case "val":
      case "var": {
        const name = declaredMemberName(tokens, i);
        if (name === undefined) break;
        localMembers.add(name);
        if (topLevelPosition && !isScript && !isPrivate(tokens, i)) {
          topLevel.add(name);
          hasTopLevelMembers = true;
        }
        break;
      }
    }
  }

  const references = collectReferences(tokens);
  const facts: SyntaxFacts = {
    imports: buildJvmImports({
      pkg,
      imports,
      localTypes,
      localMembers,
      references,
      includeCalls: true,
    }),
  };

  if (!isScript) {
    const declares = new Set<string>();
    for (const name of topLevel) declares.add(fqn(pkg, name));
    // Java sees top-level functions/properties as static members of `<File>Kt`
    // (or the `@file:JvmName`), so a Java `import a.b.UtilsKt;` must resolve here.
    if (hasTopLevelMembers) {
      declares.add(fqn(pkg, jvmFileName(source) ?? defaultFileClass(file)));
    }
    if (declares.size > 0) facts.declares = [...declares];
  }
  return facts;
}
