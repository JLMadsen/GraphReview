/**
 * Path helpers. Every path that crosses a module boundary in this package is
 * repo-relative and POSIX-separated, regardless of host OS.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** Convert a host path fragment to POSIX separators. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/").replace(/\\/g, "/");
}

/** Repo-relative POSIX path of `absolutePath` inside `rootDir`. */
export function repoRelative(rootDir: string, absolutePath: string): string {
  return toPosix(path.relative(rootDir, absolutePath));
}

/** Lower-cased extension including the dot (`.ts`), or `""` when there is none. */
export function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/** Directory part of a repo-relative POSIX path; `""` for a file at the root. */
export function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? "" : filePath.slice(0, slash);
}

/** Join + normalize repo-relative POSIX segments, collapsing `.`/`..`. */
export function joinPosix(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    for (const segment of part.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        if (segments.length > 0 && segments[segments.length - 1] !== "..") {
          segments.pop();
        } else {
          segments.push("..");
        }
        continue;
      }
      segments.push(segment);
    }
  }
  return segments.join("/");
}

/** Candidate roots the analysis assets (queries, grammars) may live under. */
function assetRoots(hintDir?: string): string[] {
  const roots: string[] = [];
  const push = (dir: string) => {
    if (dir && !roots.includes(dir)) roots.push(dir);
  };
  if (hintDir) {
    let dir = hintDir;
    for (let i = 0; i < 8; i++) {
      push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  let cwd = process.cwd();
  for (let i = 0; i < 8; i++) {
    push(cwd);
    const parent = path.dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return roots;
}

/**
 * Locate `lib/analysis/languages/<languageId>/`.
 *
 * `hintDir` is the caller's own directory when it is knowable (`__dirname`
 * under CommonJS); otherwise we walk up from the working directory. Deliberately
 * avoids `import.meta.url` so the module behaves the same under `tsx`, the
 * Next.js server bundle and plain Node.
 */
export function resolveLanguageDir(languageId: string, hintDir?: string): string {
  const override = process.env.GRAPHREVIEW_ANALYSIS_LANGUAGES_DIR;
  const marker = "queries.scm";
  const candidates: string[] = [];
  if (override) candidates.push(path.join(override, languageId));
  if (hintDir) candidates.push(hintDir);
  for (const root of assetRoots(hintDir)) {
    candidates.push(path.join(root, "lib", "analysis", "languages", languageId));
  }
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, marker))) return candidate;
  }
  return candidates[0] ?? path.join(process.cwd(), "lib", "analysis", "languages", languageId);
}

/**
 * Candidate absolute paths for a prebuilt tree-sitter grammar, in priority
 * order: explicit override, vendored next to the analyzer, then the
 * `@vscode/tree-sitter-wasm` package in any reachable `node_modules`.
 */
export function grammarCandidates(wasmFileName: string, languageDir?: string): string[] {
  const candidates: string[] = [];
  const override = process.env.GRAPHREVIEW_GRAMMAR_DIR;
  if (override) candidates.push(path.join(override, wasmFileName));
  if (languageDir) candidates.push(path.join(languageDir, wasmFileName));
  for (const root of assetRoots(languageDir)) {
    candidates.push(
      path.join(root, "node_modules", "@vscode", "tree-sitter-wasm", "wasm", wasmFileName),
    );
  }
  return candidates;
}
