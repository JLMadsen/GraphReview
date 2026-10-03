// What the model needs to see to mock a server call well (DESIGN.md §6.9):
// the types a server action's module imports (so `user` comes back with the
// `permissions` the type says it has) and the code that calls it (so the
// value fits how it's used — `checkSession().then(({ authenticated, user }) => …)`).
// Read from the side's checked-out tree; best effort, small and capped.

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const MAX_CHARS = 4000;
const MAX_TYPE_FILES = 3;
const MAX_CALLERS = 2;
const MAX_SCANNED = 3000;
const SOURCE_DIRS = ["app", "src", "components", "lib", "contexts", "context", "providers", "hooks", "store", "stores", "features", "actions", "services"];
const SKIP = new Set(["node_modules", ".next", "dist", "build", "out", ".git", "public", "coverage"]);
const TYPE_PATH = /(^|\/)(types?|models?|schemas?|interfaces?|dtos?|entities)(\/|[._-]|$)/i;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

export interface RelatedSource {
  path: string;
  source: string;
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/[^\n]*/g, "$1").replace(/,(\s*[}\]])/g, "$1");
}

/** `"@/*": ["./*"]`-style aliases from the project's tsconfig/jsconfig. */
async function pathAliases(root: string): Promise<Array<{ prefix: string; targets: string[] }>> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    try {
      const config = JSON.parse(stripJsonComments(await readFile(file, "utf8")));
      const baseUrl = config.compilerOptions?.baseUrl ?? ".";
      const paths: Record<string, string[]> = config.compilerOptions?.paths ?? {};
      return Object.entries(paths).map(([key, targets]) => ({
        prefix: key.replace(/\*$/, ""),
        targets: targets.map((t) => path.posix.join(baseUrl, t.replace(/\*$/, ""))),
      }));
    } catch {
      return [];
    }
  }
  return [];
}

function resolveFile(root: string, candidate: string): string | null {
  for (const ext of ["", ...EXTENSIONS]) {
    const file = path.join(root, candidate + ext);
    if (existsSync(file) && !file.endsWith(path.sep)) {
      try {
        if (/\.(t|j)sx?$/.test(file)) return file;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

async function resolveImport(
  root: string,
  fromRel: string,
  spec: string,
  aliases: Array<{ prefix: string; targets: string[] }>
): Promise<string | null> {
  if (spec.startsWith(".")) return resolveFile(root, path.posix.join(path.posix.dirname(fromRel), spec));
  for (const alias of aliases) {
    if (!spec.startsWith(alias.prefix)) continue;
    for (const target of alias.targets) {
      const hit = resolveFile(root, path.posix.join(target, spec.slice(alias.prefix.length)));
      if (hit) return hit;
    }
  }
  return null;
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string, depth: number) => {
    if (files.length >= MAX_SCANNED || depth > 8) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_SCANNED) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) await visit(full, depth + 1);
      } else if (/\.(t|j)sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  };
  for (const dir of SOURCE_DIRS) {
    const full = path.join(root, dir);
    if (existsSync(full)) await visit(full, 0);
  }
  return files;
}

function clip(text: string): string {
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n… (truncated)`;
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * The type files and callers of the given server-action modules (paths
 * relative to `root`, the project root of a checked-out side), excluding
 * `skip` (the changed file, which the model sees anyway).
 */
export async function relatedSources(
  root: string,
  modules: readonly string[],
  skip: readonly string[],
  /** Files whose type imports matter too, without looking for their callers — the changed component, which consumes the data. */
  consumers: readonly string[] = []
): Promise<RelatedSource[]> {
  const out = new Map<string, string>();
  const skipSet = new Set([...skip, ...modules]);
  const aliases = await pathAliases(root);

  for (const moduleRel of [...consumers, ...modules]) {
    const source = await readFile(path.join(root, moduleRel), "utf8").catch(() => null);
    if (!source) continue;
    let types = 0;
    for (const m of source.matchAll(/import\s+(type\s+)?[^"';]*?from\s*["']([^"']+)["']/g)) {
      if (types >= MAX_TYPE_FILES) break;
      const isTypeImport = Boolean(m[1]) || TYPE_PATH.test(m[2]);
      if (!isTypeImport) continue;
      const file = await resolveImport(root, moduleRel, m[2], aliases);
      if (!file) continue;
      const key = rel(root, file);
      if (skipSet.has(key) || out.has(key)) continue;
      out.set(key, clip(await readFile(file, "utf8")));
      types += 1;
    }
  }

  // Callers: files whose imports name one of the modules (by its path tail, extension-less).
  const tails = modules.map((m) => m.replace(/\.(t|j)sx?$/, "").split("/").slice(-2).join("/"));
  const callers: RelatedSource[] = [];
  for (const file of await walk(root)) {
    if (callers.length >= MAX_CALLERS * modules.length) break;
    const key = rel(root, file);
    if (skipSet.has(key) || out.has(key)) continue;
    const text = await readFile(file, "utf8").catch(() => "");
    if (!/\bimport\b/.test(text)) continue;
    if (!tails.some((tail) => text.includes(tail))) continue;
    callers.push({ path: key, source: clip(text) });
  }
  // Providers and contexts first: they gate whole pages (sessions, permissions).
  callers.sort((a, b) => Number(/provider|context/i.test(b.path)) - Number(/provider|context/i.test(a.path)));
  for (const caller of callers.slice(0, MAX_CALLERS + 1)) out.set(caller.path, caller.source);

  return [...out].map(([p, source]) => ({ path: p, source }));
}
