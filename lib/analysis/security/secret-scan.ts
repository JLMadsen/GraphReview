/**
 * The diff-wide secret scan (DESIGN.md §6.26 §1): every line a change adds,
 * in any file — code, test fixtures, `.pem` files, docs — checked for a
 * known token shape, a PEM private key, a URL with a password, or a
 * high-entropy value assigned to a secret-looking name. Deterministic, no
 * model call.
 *
 * A hit never carries the value: only the file, the line and the kind.
 * Lockfiles, minified files and placeholders (`xxx`, `<token>`, `changeme`,
 * `example`, `${VAR}`) are skipped to keep false positives low.
 */
import { createHash } from "node:crypto";
import { entropy, isPlaceholder, isSecretName, isSecretValue, TOKEN_KINDS, unquote } from "../env/secret";

export interface SecretHit {
  file: string;
  line: number;
  /** What it looks like: "GitHub token", "private key", "URL with a password", "high-entropy value for apiKey". */
  kind: string;
  /** A short hash of the value — tells two hits apart and keeps a finding's id stable when lines shift. Never the value. */
  fingerprint: string;
}

/** Most hits a single diff reports; past this the change is a dump of credentials and the count says so. */
export const MAX_SECRET_HITS = 50;
/** Longer added lines are minified or generated; scanning them only finds noise. */
const MAX_LINE = 2000;

const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock|packages\.lock\.json|gradle\.lockfile|mix\.lock|pubspec\.lock|Podfile\.lock|[^/]+\.lock)$/;
const SKIPPED_FILE = /\.(min\.(js|css)|map|snap|svg|ipynb)$/i;

/** Words that mark a token as a stand-in, wherever they sit in it (`ghp_xxxx…`, `AKIAIOSFODNN7EXAMPLE`). */
const PLACEHOLDER_WORD = /x{4,}|example|placeholder|changeme|change_me|dummy|fake|redacted|your[_-]|<[^>]*>|\$\{|\{\{|\*{4,}|\.{3}|…/i;

export function isScannedFile(path: string): boolean {
  return !LOCKFILE.test(path) && !SKIPPED_FILE.test(path);
}

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

/** A token stands in for one: a placeholder word, or a body with too little randomness (`ghp_000…`, `AKIAAAAA…`). */
function placeholderToken(token: string): boolean {
  if (PLACEHOLDER_WORD.test(token)) return true;
  const body = token.replace(/^(?:[a-z]{2,4}[_-](?:live_|test_|pat_|proj-|ant-)?|github_pat_|AKIA|ASIA|AIza|SG\.)/i, "");
  return body.length >= 8 && entropy(body) < 3;
}

const TOKEN_ANYWHERE = TOKEN_KINDS.map((t) => ({ kind: t.kind, re: new RegExp(`(?<![A-Za-z0-9_])(?:${t.pattern})`, "g") }));
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^:@/\s"'`]+:([^@/\s"'`]+)@[^\s"'`]+/gi;
/** `apiKey = "…"`, `"client_secret": "…"`, `SECRET=…`, `token: …` — a name, then a value. */
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*(?::=|=>|[:=])\s*(["'`]?)([^\s"'`,;)]{16,})\2/g;

/** `apiKey` / `client-secret` / `db.password` → `API_KEY` / `CLIENT_SECRET` / `PASSWORD`, for {@link isSecretName}. */
function secretNameOf(name: string): string {
  const last = name.split(".").pop()!;
  return last.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toUpperCase();
}

/** Secrets in one added line: each kind once, the value never kept. */
export function secretsInLine(text: string): Array<{ kind: string; fingerprint: string }> {
  if (text.length > MAX_LINE) return [];
  const out: Array<{ kind: string; fingerprint: string }> = [];
  const taken: Array<[number, number]> = [];
  const add = (kind: string, value: string, at: number) => {
    if (taken.some(([s, e]) => at < e && at + value.length > s)) return;
    taken.push([at, at + value.length]);
    out.push({ kind, fingerprint: fingerprint(value) });
  };
  for (const { kind, re } of TOKEN_ANYWHERE) {
    for (const m of text.matchAll(re)) {
      if (kind !== "private key" && placeholderToken(m[0])) continue;
      add(kind, m[0], m.index!);
    }
  }
  for (const m of text.matchAll(URL_PASSWORD)) {
    const password = m[1];
    if (isPlaceholder(m[0]) || isPlaceholder(password) || PLACEHOLDER_WORD.test(password) || /^[$%]/.test(password)) continue;
    add("URL with a password", m[0], m.index!);
  }
  for (const m of text.matchAll(ASSIGNMENT)) {
    const [, name, , raw] = m;
    const value = unquote(raw);
    if (!isSecretName(secretNameOf(name)) || placeholderToken(value) || !isSecretValue(value)) continue;
    // A reference, not a value: `process.env.X`, `settings.SECRET_KEY`, a call.
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)) continue;
    add(`high-entropy value for ${name}`, value, m.index! + m[0].lastIndexOf(raw));
  }
  return out;
}

/**
 * Every secret on a line the diff adds. Takes `git diff` output (any
 * context size); removed and context lines are ignored.
 */
export function scanDiffForSecrets(diff: string): { hits: SecretHit[]; capped: boolean } {
  const hits: SecretHit[] = [];
  let file: string | undefined;
  let line = 0;
  let inHunk = false;
  for (const row of diff.split("\n")) {
    if (row.startsWith("diff --git ")) {
      inHunk = false;
      file = undefined;
      continue;
    }
    if (!inHunk && row.startsWith("+++ ")) {
      const path = row.slice(4).trim();
      file = path === "/dev/null" ? undefined : path.replace(/^b\//, "");
      if (file && !isScannedFile(file)) file = undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      inHunk = true;
      line = Number(hunk[1]);
      continue;
    }
    if (!inHunk) continue;
    if (row.startsWith("+")) {
      if (file) {
        for (const s of secretsInLine(row.slice(1))) {
          if (hits.length >= MAX_SECRET_HITS) return { hits, capped: true };
          hits.push({ file, line, ...s });
        }
      }
      line++;
    } else if (row.startsWith(" ")) {
      line++;
    }
  }
  return { hits, capped: false };
}
