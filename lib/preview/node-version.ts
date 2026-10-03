// Which Node.js major a previewed repo needs (DESIGN.md §6.9).
//
// The sandbox used to be a fixed `node:20` image, so a repo that needs a
// newer runtime failed to load ("No such built-in module: node:sqlite").
// The repo says what it wants, nearest to the previewed file first:
// `.nvmrc` / `.node-version` (a pin), `volta.node` (a pin), then
// `engines.node` (a range — the newest sensible major inside it). Nothing
// found means DEFAULT_NODE_MAJOR. Pure parsing; the caller supplies a reader.

/** The current LTS line; also the default for repos that don't say. */
export const DEFAULT_NODE_MAJOR = 22;
/** Oldest major the sandbox runs (older ones have no Debian bookworm image). */
const MIN_NODE_MAJOR = 18;

const clamp = (major: number) => Math.max(MIN_NODE_MAJOR, major);

/** One `||` alternative of a semver range → the major to run it on, or `undefined`. */
function majorForRangePart(part: string): number | undefined {
  const text = part.trim().replace(/^v/, "");
  if (!text || text === "*" || text === "x") return DEFAULT_NODE_MAJOR;
  // A pinned major: `20`, `20.11.1`, `20.x`, `^20.3`, `~20.1`, `=20`.
  const pinned = /^(?:[\^~=]\s*v?)?(\d+)(?:\.(?:\d+|x|\*))*$/.exec(text);
  if (pinned) return Number(pinned[1]);
  // A lower bound, maybe with an upper one: `>=18`, `>=20 <23`, `>16.0.0`.
  const lower = /(>=?)\s*v?(\d+)/.exec(text);
  const upper = /<(=?)\s*v?(\d+)(?:\.(\d+))?/.exec(text);
  if (lower || upper) {
    const low = lower ? Number(lower[2]) : MIN_NODE_MAJOR;
    let high = Number.POSITIVE_INFINITY;
    if (upper) {
      const bound = Number(upper[2]);
      // `<23` excludes 23; `<=22` and `<22.5` still allow 22.
      high = upper[1] || (upper[3] && Number(upper[3]) > 0) ? bound : bound - 1;
    }
    return Math.min(Math.max(low, DEFAULT_NODE_MAJOR), high);
  }
  return undefined;
}

/** A version spec (`.nvmrc` content, `volta.node`, or an `engines.node` range) → a major, or `undefined`. */
export function nodeMajorFromSpec(spec: string): number | undefined {
  const text = spec.trim().toLowerCase();
  if (!text) return undefined;
  if (text.startsWith("lts") || text === "node" || text === "latest" || text === "stable") return DEFAULT_NODE_MAJOR;
  const majors = text
    .split("||")
    .map(majorForRangePart)
    .filter((major): major is number => major !== undefined && Number.isFinite(major));
  return majors.length > 0 ? clamp(Math.max(...majors)) : undefined;
}

/**
 * The Node major `filePath`'s project asks for, looking in its directory and
 * each parent up to the repo root. `undefined` when nothing says.
 */
export async function requiredNodeMajor(
  read: (repoPath: string) => Promise<string | null>,
  filePath: string
): Promise<number | undefined> {
  const parts = filePath.split("/").slice(0, -1);
  for (let depth = parts.length; depth >= 0; depth--) {
    const dir = parts.slice(0, depth).join("/");
    const at = (name: string) => (dir ? `${dir}/${name}` : name);

    for (const pinFile of [".nvmrc", ".node-version"]) {
      const pin = await read(at(pinFile));
      const major = pin ? nodeMajorFromSpec(pin.split("\n")[0] ?? "") : undefined;
      if (major) return major;
    }

    const manifest = await read(at("package.json"));
    if (!manifest) continue;
    try {
      const pkg = JSON.parse(manifest) as { volta?: { node?: unknown }; engines?: { node?: unknown } };
      for (const spec of [pkg.volta?.node, pkg.engines?.node]) {
        const major = typeof spec === "string" ? nodeMajorFromSpec(spec) : undefined;
        if (major) return major;
      }
    } catch {
      /* unreadable package.json — keep looking upwards */
    }
  }
  return undefined;
}
