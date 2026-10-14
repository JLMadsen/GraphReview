/**
 * Secret-looking names and values, and placeholders (DESIGN.md §6.15 §2).
 * A short deterministic classifier — never a model call — used for the
 * view's tags, the "committed secret" finding, and to keep secret values
 * out of what reaches the model.
 */

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|(^|_)PWD$|PRIVATE_KEY|API_KEY|APIKEY|CREDENTIAL|(^|_)AUTH($|_)|SALT|(^|_)KEY$|_KEY_)/;
const PUBLIC_KEY_NAME = /(PUBLIC_KEY|PUBLISHABLE_KEY|PUBKEY|_KEY_ID$|KEY_NAME$|KEY_PREFIX$|KEY_PATH$|KEY_FILE$|_HEADER$|_ENABLED$|_URL$|_URI$)/;

/** A name that holds a secret by convention. */
export function isSecretName(name: string): boolean {
  const n = name.toUpperCase();
  return SECRET_NAME.test(n) && !PUBLIC_KEY_NAME.test(n);
}

const PLACEHOLDER = /^(|changeme|change[-_]?me|change[-_]?this|replace[-_]?me|x+|\*+|\.{3}|…|todo|tbd|none|null|nil|undefined|example|secret|password|test|dummy|fake|sample|placeholder|default|your[-_ ].*|your|<.*>|\[.*\]|\{\{.*\}\}|\$\{.*\}|\$\(.*\)|%.*%|sk_test_\w*|pk_test_\w*|.*_here|.*\bexample\b.*)$/i;

/** A value that stands in for one (empty, `changeme`, `<your-key>`, `${X}`, a test key). */
export function isPlaceholder(value: string): boolean {
  const v = unquote(value).trim();
  if (PLACEHOLDER.test(v)) return true;
  // A connection URL to a local machine: a dev credential, not a real one.
  if (/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)\b/i.test(v)) return true;
  // A URL whose password is a stock one (`postgres://user:pass@db`).
  const pw = /^[a-z][a-z0-9+.-]*:\/\/[^:@/\s]+:([^@/\s]+)@/i.exec(v);
  if (pw && /^(pass|password|postgres|root|admin|user|secret|changeme|example|test|dev)$/i.test(pw[1])) return true;
  // The same character over and over (`aaaa`, `0000`).
  if (v.length >= 4 && new Set(v).size === 1) return true;
  return false;
}

const TOKEN_PREFIX = /^(sk-[A-Za-z0-9_-]{16,}|sk_live_\w{8,}|rk_live_\w{8,}|ghp_\w{20,}|gho_\w{20,}|ghs_\w{20,}|github_pat_\w{20,}|glpat-[\w-]{16,}|xox[abpr]-[\w-]{10,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[\w-]{30,}|SG\.[\w-]{16,}\.[\w-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A value shaped like a secret: a known token prefix, a PEM block, a URL with a password, a long random string. */
export function isSecretValue(value: string): boolean {
  const v = unquote(value).trim();
  if (!v || isPlaceholder(v)) return false;
  if (TOKEN_PREFIX.test(v)) return true;
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^:@/\s]+:([^@/\s]+)@/i.exec(v);
  if (url) return !isPlaceholder(url[1]) && !/^\$\{?/.test(url[1]);
  if (/^[A-Za-z0-9+/_=-]{24,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && entropy(v) >= 3.5) return true;
  return false;
}

export function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'" || v[0] === "`") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

/**
 * What the model may see of a value (§6.15 §5): non-secret values as they
 * are; a secret-looking one as `<set, N chars>` or `<placeholder>`.
 */
export function valueForModel(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = unquote(value);
  if (!isSecretName(name) && !isSecretValue(v)) return v.length > 120 ? `${v.slice(0, 117)}…` : v;
  return isPlaceholder(v) ? "<placeholder>" : `<set, ${v.length} chars>`;
}
