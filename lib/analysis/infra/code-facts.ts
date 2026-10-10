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

export interface CodeFacts {
  /** `[name, line]` per read. */
  env?: Array<[string, number]>;
  /** `[port, line]` per literal listen port. */
  ports?: Array<[number, number]>;
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

/** The env reads and literal listen ports of one file, or `undefined` when there are none. */
export function scanCodeFacts(language: string, source: string): CodeFacts | undefined {
  const family = familyOf(language);
  if (!family) return undefined;
  // Cheap pre-checks: most files read no env and listen on nothing.
  const mayEnv = /env|getenv|environ|\$\{/i.test(source);
  const mayPort = /listen|port|serve|Run\(|Start\(/i.test(source);
  if (!mayEnv && !mayPort) return undefined;
  const env: Array<[string, number]> = [];
  const ports: Array<[number, number]> = [];
  const seenEnv = new Set<string>();
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (text.length > 2000 || COMMENT_LINE.test(text)) continue;
    if (mayEnv) {
      for (const pattern of PATTERNS[family]) {
        pattern.lastIndex = 0;
        for (const m of text.matchAll(pattern)) {
          const key = `${m[1]}:${i + 1}`;
          if (seenEnv.has(key)) continue;
          seenEnv.add(key);
          env.push([m[1], i + 1]);
        }
      }
      // `const { A, B: b } = process.env`
      if (family === "js") {
        const d = /\{([^}]*)\}\s*=\s*process\.env\b/.exec(text);
        if (d) {
          for (const part of d[1].split(",")) {
            const name = part.split(":")[0].split("=")[0].trim();
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !seenEnv.has(`${name}:${i + 1}`)) {
              seenEnv.add(`${name}:${i + 1}`);
              env.push([name, i + 1]);
            }
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
  if (env.length === 0 && ports.length === 0) return undefined;
  return { ...(env.length ? { env } : {}), ...(ports.length ? { ports } : {}) };
}

/** `${NAME}` / `${NAME:default}` placeholders and `server.port` in a Spring `application.properties` / `.yml`. */
export function scanSpringConfig(source: string): CodeFacts | undefined {
  const env: Array<[string, number]> = [];
  const ports: Array<[number, number]> = [];
  const lines = source.split("\n");
  let yamlServer = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (/^\s*#/.test(text)) continue;
    for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::([^}]*))?\}/g)) env.push([m[1], i + 1]);
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
