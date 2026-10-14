/**
 * What the app's own code says about how it runs (DESIGN.md §6.12 §1): the
 * env vars it reads and the ports it listens on where they are literal.
 * TS/JS, Python, Java/Kotlin and Go.
 *
 * As built this is a lexical scan of the source, run beside the parse and
 * cached with it by blob — not part of the tree-sitter extract: Go has no
 * symbol facts at all, and the patterns are single-line calls a scan reads
 * as reliably as a tree. Comment lines are skipped. Names built at runtime
 * (`process.env[name]`) are never guessed.
 */
import { scanEnvDecls, type EnvDeclFact } from "../env/declare";

/** How a read is written (DESIGN.md §6.15 §1): `f` its fallback (the literal, or `…`), `r` required, `m` through `import.meta.env`. */
export interface EnvReadFlags {
  f?: string;
  r?: 1;
  m?: 1;
}

export interface CodeFacts {
  /** `[name, line, flags?]` per read. */
  env?: Array<[string, number, EnvReadFlags?]>;
  /** `[port, line]` per literal listen port. */
  ports?: Array<[number, number]>;
  /** The file starts with a `"use client"` directive. */
  client?: true;
  /** A `"use server"` file or one that imports `server-only`: importing it never puts its code in the browser. */
  server?: true;
  /** Typed env schema entries (../env/declare.ts): `[name, line, decl]`. */
  decl?: Array<[string, number, EnvDeclFact]>;
}

const ENV_NAME = "[A-Za-z_][A-Za-z0-9_]*";
const q = `["'\`]`;

const PATTERNS: Record<string, RegExp[]> = {
  js: [
    new RegExp(`process\\.env\\.(${ENV_NAME})`, "g"),
    new RegExp(`process\\.env\\[\\s*${q}(${ENV_NAME})${q}\\s*\\]`, "g"),
    new RegExp(`import\\.meta\\.env\\.(${ENV_NAME})`, "g"),
    new RegExp(`(?:Deno\\.env\\.get|Bun\\.env\\.get)\\(\\s*${q}(${ENV_NAME})${q}`, "g"),
    new RegExp(`Bun\\.env\\.(${ENV_NAME})`, "g"),
  ],
  python: [
    new RegExp(`os\\.environ\\[\\s*["'](${ENV_NAME})["']\\s*\\]`, "g"),
    new RegExp(`(?:os\\.)?environ\\.get\\(\\s*["'](${ENV_NAME})["']`, "g"),
    new RegExp(`os\\.getenv\\(\\s*["'](${ENV_NAME})["']`, "g"),
    new RegExp(`environ\\.setdefault\\(\\s*["'](${ENV_NAME})["']`, "g"),
  ],
  jvm: [
    new RegExp(`System\\.getenv\\(\\s*"(${ENV_NAME})"`, "g"),
    // Spring `@Value("${NAME}")` / `${NAME:default}` placeholders in code (not Kotlin string templates)
    /@Value\(\s*"\$\{([A-Z][A-Z0-9_]*)(?::[^}]*)?\}/g,
  ],
  go: [new RegExp(`os\\.(?:Getenv|LookupEnv)\\(\\s*"(${ENV_NAME})"`, "g")],
};

const PORT_PATTERNS: Record<string, RegExp[]> = {
  js: [
    /\.listen\(\s*(\d{2,5})\b/g,
    /\.listen\(\s*\{[^}]*\bport\s*:\s*(\d{2,5})\b/g,
    /\bPORT\b['"\]]?\s*\)?\s*(?:\?\?|\|\|)\s*['"]?(\d{2,5})\b/g,
    /\bserve\(\s*\{[^}]*\bport\s*:\s*(\d{2,5})\b/g,
  ],
  python: [
    /\b(?:uvicorn|app|web|socketio|server)\.run\([^)]*\bport\s*=\s*(\d{2,5})\b/g,
    /\bgetenv\(\s*["']PORT["']\s*,\s*["']?(\d{2,5})/g,
    /environ\.get\(\s*["']PORT["']\s*,\s*["']?(\d{2,5})/g,
    /--port["',\s=]+(\d{2,5})\b/g,
  ],
  jvm: [/\bserver\.port\s*[=:]\s*(\d{2,5})\b/g, /\$\{PORT:(\d{2,5})\}/g],
  go: [/(?:ListenAndServe(?:TLS)?|Listen|\.Run|\.Start)\(\s*(?:"tcp"\s*,\s*)?"[^":]*:(\d{2,5})"/g],
};

function familyOf(language: string): keyof typeof PATTERNS | undefined {
  if (language === "typescript" || language === "tsx" || language === "javascript") return "js";
  if (language === "python") return "python";
  if (language === "java" || language === "kotlin") return "jvm";
  if (language === "go") return "go";
  return undefined;
}

const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*)/;

/** A literal at the start of `text`: a quoted string, a number, `true`/`false`/`None`; `…` for anything else. */
function literalAt(text: string): string {
  const t = text.trimStart();
  const str = /^(["'`])((?:\\.|(?!\1).)*)\1/.exec(t);
  if (str) return str[2];
  const word = /^(-?\d+(?:\.\d+)?|true|false|True|False|None|null)\b/.exec(t);
  return word ? word[1] : "…";
}

const GUARD = /\b(throw|panic|raise|sys\.exit|process\.exit|log\.Fatal|os\.Exit)\b/;

/**
 * How the read at `rest` (the line after the match; `before` is the line up
 * to it) is written. A fallback `f` is the literal, or `…` when the code
 * handles a missing value some other way: optional chaining, a comparison
 * (`!== "1"`), a ternary, `&&`, a bare `if (…)`.
 */
function readFlags(family: string, matched: string, rest: string, line: string, before = ""): EnvReadFlags | undefined {
  const flags: EnvReadFlags = {};
  if (matched.startsWith("import.meta")) flags.m = 1;
  if (family === "js") {
    // `X ?? d`, `X || d`, `X?.trim() || d`, `Number(X) || d`
    const fb = /^\s*\]?\s*(?:\?\.\s*\w+\s*\([^()]*\)\s*)*\)?\s*(\?\?|\|\|)\s*/.exec(rest);
    if (fb) flags.f = literalAt(rest.slice(fb[0].length));
    else if (/^\s*!(?!=)/.test(rest)) flags.r = 1;
    else if (!GUARD.test(line) && (/^\s*\]?\s*(?:\?\.|!==?|===?|&&|\?(?![?.]))/.test(rest) || /\bif\s*\(\s*!?\s*$/.test(before))) flags.f = "…";
  } else if (family === "python") {
    if (/^\s*,/.test(rest) && /(?:getenv|\.get|setdefault)\(/.test(matched)) flags.f = literalAt(rest.replace(/^\s*,\s*(?:default\s*=\s*)?/, ""));
    else if (/environ\[/.test(matched)) flags.r = 1;
  } else if (family === "jvm") {
    const spring = /:([^}]*)\}/.exec(matched);
    if (spring) flags.f = spring[1];
  }
  if (!flags.f && GUARD.test(line)) flags.r = 1;
  return flags.f !== undefined || flags.r || flags.m ? flags : undefined;
}

const USE_CLIENT = /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*["']use client["']/;
const USE_SERVER = /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*["']use server["']|^\s*import\s+["']server-only["']/m;

/** The env reads and literal listen ports of one file, or `undefined` when there are none. */
export function scanCodeFacts(language: string, source: string): CodeFacts | undefined {
  const family = familyOf(language);
  if (!family) return undefined;
  const client = family === "js" && USE_CLIENT.test(source.slice(0, 2000));
  const server = family === "js" && !client && USE_SERVER.test(source.slice(0, 4000));
  const marks = { ...(client ? { client: true as const } : {}), ...(server ? { server: true as const } : {}) };
  // Cheap pre-checks: most files read no env and listen on nothing.
  const mayEnv = /env|getenv|environ|Settings|\$\{/i.test(source);
  const mayPort = /listen|port|serve|Run\(|Start\(/i.test(source);
  if (!mayEnv && !mayPort) return client || server ? marks : undefined;
  const env: Array<[string, number, EnvReadFlags?]> = [];
  const ports: Array<[number, number]> = [];
  const seenEnv = new Set<string>();
  const push = (name: string, line: number, flags?: EnvReadFlags) => {
    const key = `${name}:${line}`;
    if (seenEnv.has(key)) return;
    seenEnv.add(key);
    env.push(flags ? [name, line, flags] : [name, line]);
  };
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (text.length > 2000 || COMMENT_LINE.test(text)) continue;
    if (mayEnv) {
      for (const pattern of PATTERNS[family]) {
        pattern.lastIndex = 0;
        for (const m of text.matchAll(pattern)) {
          const at = m.index ?? 0;
          const rest = text.slice(at + m[0].length);
          // A write (`process.env.X = "0"`, `os.environ["X"] = …`, `delete process.env.X`) isn't a read;
          // `??=` / `||=` gives later reads a default.
          if (/^\s*\]?\s*=(?!=)/.test(rest) || /\bdelete\s+$/.test(text.slice(0, at))) continue;
          const assignDefault = /^\s*(?:\?\?|\|\|)=\s*/.exec(rest);
          push(m[1], i + 1, assignDefault ? { f: literalAt(rest.slice(assignDefault[0].length)) } : readFlags(family, m[0], rest, text, text.slice(0, at)));
        }
      }
      // `const { A, B: b = "x" } = process.env`
      if (family === "js") {
        const d = /\{([^}]*)\}\s*=\s*process\.env\b/.exec(text);
        if (d) {
          for (const part of d[1].split(",")) {
            const name = part.split(":")[0].split("=")[0].trim();
            const def = part.includes("=") ? literalAt(part.slice(part.indexOf("=") + 1)) : undefined;
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) push(name, i + 1, def !== undefined ? { f: def } : undefined);
          }
        }
      }
    }
    if (mayPort) {
      for (const pattern of PORT_PATTERNS[family]) {
        pattern.lastIndex = 0;
        for (const m of text.matchAll(pattern)) {
          const port = Number(m[1]);
          if (port > 0 && port < 65536 && !ports.some(([p]) => p === port)) ports.push([port, i + 1]);
        }
      }
    }
    if (env.length > 400) break;
  }
  const decl = mayEnv ? scanEnvDecls(family, source) : undefined;
  if (env.length === 0 && ports.length === 0 && !decl?.length && !client && !server) return undefined;
  return {
    ...(env.length ? { env } : {}),
    ...(ports.length ? { ports } : {}),
    ...marks,
    ...(decl?.length ? { decl } : {}),
  };
}

/** `${NAME}` / `${NAME:default}` placeholders and `server.port` in a Spring `application.properties` / `.yml`. */
export function scanSpringConfig(source: string): CodeFacts | undefined {
  const env: Array<[string, number, EnvReadFlags?]> = [];
  const ports: Array<[number, number]> = [];
  const lines = source.split("\n");
  let yamlServer = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (/^\s*#/.test(text)) continue;
    for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::([^}]*))?\}/g)) env.push(m[2] !== undefined ? [m[1], i + 1, { f: m[2] }] : [m[1], i + 1]);
    const prop = /^\s*server\.port\s*[=:]\s*(?:\$\{[A-Z_]+:)?(\d{2,5})/.exec(text);
    if (prop) ports.push([Number(prop[1]), i + 1]);
    // yaml: `server:` then an indented `port: 8080`
    if (/^server:\s*$/.test(text)) yamlServer = true;
    else if (/^\S/.test(text)) yamlServer = false;
    else if (yamlServer) {
      const y = /^\s+port:\s*["']?(?:\$\{[A-Z_]+:)?(\d{2,5})/.exec(text);
      if (y) ports.push([Number(y[1]), i + 1]);
    }
  }
  if (env.length === 0 && ports.length === 0) return undefined;
  return { ...(env.length ? { env } : {}), ...(ports.length ? { ports } : {}) };
}
