/**
 * A tiny, grammar-free tokenizer for Java and Kotlin source text.
 *
 * It exists for two jobs the tree-sitter path cannot do cheaply: reading Kotlin at
 * all (see `kotlin/index.ts` for why a grammar is not used there) and finding the
 * *type references* of a file - the capitalised names that stand for same-package
 * or wildcard-imported classes, which need no `import` statement.
 *
 * It yields only *code* tokens: identifiers and single punctuation characters.
 * Block/line comments, string literals (regular, raw `"""`, Java text blocks) and
 * character literals are skipped, so imports or class names "inside" them never
 * appear. Kotlin string templates are the exception on purpose: the code inside
 * `"${ ... }"` is real code and is tokenized (recursively, with its own strings).
 *
 * Deliberately forgiving: unterminated strings end at the newline, unbalanced
 * input never throws, and everything is one linear pass.
 */

export interface Token {
  /** `id` = identifier/keyword (backtick-quoted Kotlin names lose their quotes); `p` = punctuation. */
  k: "id" | "p";
  /** The identifier text, or the punctuation (`{ } ( ) < > . , : ; = @ * ? ::`, `->`). */
  v: string;
}

export interface TokenizeOptions {
  /** Kotlin: nested `/* /* */ */` comments and `${...}` / `$name` string templates. */
  kotlin: boolean;
}

const enum C {
  Tab = 9,
  LF = 10,
  CR = 13,
  Space = 32,
  DQuote = 34,
  Dollar = 36,
  SQuote = 39,
  Star = 42,
  Slash = 47,
  Colon = 58,
  Dash = 45,
  Gt = 62,
  Backslash = 92,
  Backtick = 96,
  LBrace = 123,
  RBrace = 125,
}

function isIdentStart(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 || // _
    c === C.Dollar ||
    c > 127 // any non-ASCII letter: good enough, we only compare ASCII case
  );
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || (c >= 48 && c <= 57);
}

export function tokenize(source: string, options: TokenizeOptions): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  const kotlin = options.kotlin;
  let i = 0;

  /** Skip a `/* ... */` comment starting at `i` (which points at the `/`). */
  function skipBlockComment(): void {
    let depth = 1;
    i += 2;
    while (i < n && depth > 0) {
      const c = source.charCodeAt(i);
      if (c === C.Star && source.charCodeAt(i + 1) === C.Slash) {
        depth--;
        i += 2;
      } else if (kotlin && c === C.Slash && source.charCodeAt(i + 1) === C.Star) {
        depth++;
        i += 2;
      } else {
        i++;
      }
    }
  }

  /** Skip a character literal starting at `i` (pointing at the opening `'`). */
  function skipChar(): void {
    i++; // opening quote
    if (source.charCodeAt(i) === C.Backslash) i += 2;
    else i++;
    // Consume up to the closing quote (a `A` escape is several characters).
    for (let guard = 0; guard < 8 && i < n; guard++) {
      const c = source.charCodeAt(i);
      if (c === C.SQuote) {
        i++;
        return;
      }
      if (c === C.LF) return;
      i++;
    }
  }

  /**
   * Skip a string literal starting at `i` (pointing at the opening `"`),
   * tokenizing the code inside Kotlin `${...}` templates.
   */
  function skipString(): void {
    const raw = source.startsWith('"""', i);
    i += raw ? 3 : 1;
    while (i < n) {
      const c = source.charCodeAt(i);
      if (raw) {
        if (c === C.DQuote && source.startsWith('"""', i)) {
          i += 3;
          while (source.charCodeAt(i) === C.DQuote) i++; // Kotlin allows extra closing quotes
          return;
        }
        // Java text blocks honour escapes (`\"""`); Kotlin raw strings do not.
        if (!kotlin && c === C.Backslash) {
          i += 2;
          continue;
        }
      } else {
        if (c === C.DQuote) {
          i++;
          return;
        }
        if (c === C.LF) return; // unterminated: do not swallow the rest of the file
        if (c === C.Backslash) {
          i += 2;
          continue;
        }
      }
      if (kotlin && c === C.Dollar) {
        const next = source.charCodeAt(i + 1);
        if (next === C.LBrace) {
          i += 2;
          scanCode(true);
          continue;
        }
        if (isIdentStart(next)) {
          i++;
          while (i < n && isIdentPart(source.charCodeAt(i))) i++;
          continue;
        }
      }
      i++;
    }
  }

  /** Tokenize code until EOF, or until the `}` closing a string template. */
  function scanCode(inTemplate: boolean): void {
    let depth = 0;
    while (i < n) {
      const c = source.charCodeAt(i);

      if (c === C.Space || c === C.Tab || c === C.LF || c === C.CR) {
        i++;
        continue;
      }
      if (c === C.Slash) {
        const next = source.charCodeAt(i + 1);
        if (next === C.Slash) {
          while (i < n && source.charCodeAt(i) !== C.LF) i++;
          continue;
        }
        if (next === C.Star) {
          skipBlockComment();
          continue;
        }
      }
      if (c === C.DQuote) {
        skipString();
        continue;
      }
      if (c === C.SQuote) {
        skipChar();
        continue;
      }
      if (kotlin && c === C.Backtick) {
        const close = source.indexOf("`", i + 1);
        if (close === -1 || source.slice(i + 1, close).includes("\n")) {
          i++;
          continue;
        }
        tokens.push({ k: "id", v: source.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
      if (isIdentStart(c)) {
        const start = i;
        i++;
        while (i < n && isIdentPart(source.charCodeAt(i))) i++;
        tokens.push({ k: "id", v: source.slice(start, i) });
        continue;
      }
      if (c >= 48 && c <= 57) {
        // Numeric literal (`0x1F`, `1_000L`, `1e5`): not an identifier, not a member access.
        i++;
        while (i < n && isIdentPart(source.charCodeAt(i))) i++;
        continue;
      }
      if (c === C.Colon && source.charCodeAt(i + 1) === C.Colon) {
        tokens.push({ k: "p", v: "::" });
        i += 2;
        continue;
      }
      if (c === C.Dash && source.charCodeAt(i + 1) === C.Gt) {
        tokens.push({ k: "p", v: "->" });
        i += 2;
        continue;
      }
      if (c === C.LBrace) depth++;
      else if (c === C.RBrace) {
        if (inTemplate && depth === 0) {
          i++; // the `}` that closes `${`
          return;
        }
        depth--;
      }
      tokens.push({ k: "p", v: source[i] });
      i++;
    }
  }

  scanCode(false);
  return tokens;
}

/** What {@link collectReferences} found. */
export interface References {
  /** Capitalised names used bare (`Foo`, `Foo.bar()`, `List<Foo>`): candidates for a same-package type. */
  simple: Set<string>;
  /** Fully-qualified names written inline (`com.acme.Foo`), up to the first capitalised segment. */
  qualified: Set<string>;
  /** Lower-case names that are *called* (`slugify(x)`, `s.shout()`): candidates for Kotlin top-level functions. */
  calls: Set<string>;
}

function isUpperFirst(name: string): boolean {
  const c = name.charCodeAt(0);
  return c >= 65 && c <= 90;
}

function isLowerFirst(name: string): boolean {
  const c = name.charCodeAt(0);
  return c >= 97 && c <= 122;
}

/**
 * Collect the identifiers that may refer to a type (or Kotlin function) declared
 * elsewhere. Purely lexical: no scoping, no overload or member resolution - the
 * result is a *candidate* set that the caller filters against the real
 * declaration index.
 */
export function collectReferences(tokens: Token[]): References {
  const simple = new Set<string>();
  const qualified = new Set<string>();
  const calls = new Set<string>();
  const count = tokens.length;

  for (let i = 0; i < count; i++) {
    const token = tokens[i];
    if (token.k !== "id") continue;

    // A call: `name(`. (Constructors are capitalised and covered by `simple`.)
    if (tokens[i + 1]?.k === "p" && tokens[i + 1].v === "(" && isLowerFirst(token.v)) {
      calls.add(token.v);
    }

    // Only chain *starts* are analysed; `x.Foo` is a member of x, not a bare type.
    const prev = tokens[i - 1];
    if (prev && prev.k === "p" && prev.v === ".") continue;

    const chain = [token.v];
    let j = i;
    while (
      tokens[j + 1]?.k === "p" &&
      tokens[j + 1].v === "." &&
      tokens[j + 2]?.k === "id"
    ) {
      chain.push(tokens[j + 2].v);
      j += 2;
    }

    if (isUpperFirst(chain[0])) {
      simple.add(chain[0]);
    } else if (chain.length > 1) {
      // `com.acme.Foo.bar()`: a package-looking prefix followed by a capitalised type.
      let k = 0;
      while (k < chain.length && isLowerFirst(chain[k])) k++;
      if (k > 0 && k < chain.length && isUpperFirst(chain[k])) {
        qualified.add(chain.slice(0, k + 1).join("."));
      }
    }
  }

  return { simple, qualified, calls };
}
