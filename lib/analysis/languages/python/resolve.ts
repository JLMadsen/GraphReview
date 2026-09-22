/**
 * Python import-specifier resolution.
 *
 * Relative imports (`from .a import b`) are resolved exactly, per Python's
 * package semantics. Absolute imports are best-effort: they are probed against a
 * small set of source roots inside the repo, and anything that does not hit a
 * real file is treated as an external dependency (PyPI package or stdlib).
 */
import type { AnalyzerContext } from "../../analyzer";
import { dirOf, joinPosix } from "../../paths";

/** Source roots absolute imports are probed against, in order. */
export const PYTHON_SOURCE_ROOTS = ["", "src"];

const FILE_SUFFIXES = [".py", ".pyi"];

interface RelativeSpec {
  /** Number of leading dots; 1 means "the current package". */
  level: number;
  /** Remaining dotted module path, `""` for a bare `from . import x`. */
  module: string;
}

/** Split `..pkg.mod` into its dot level and dotted remainder. */
export function parseRelative(spec: string): RelativeSpec | undefined {
  let level = 0;
  while (level < spec.length && spec[level] === ".") level++;
  if (level === 0) return undefined;
  return { level, module: spec.slice(level) };
}

/**
 * Try `<base>.py`, `<base>.pyi`, then the package form `<base>/__init__.py(i)`.
 * An empty `base` means the repo root itself.
 */
function probe(base: string, files: ReadonlySet<string>): string | undefined {
  if (base.startsWith("..")) return undefined;
  if (base !== "") {
    for (const suffix of FILE_SUFFIXES) {
      const candidate = base + suffix;
      if (files.has(candidate)) return candidate;
    }
  }
  for (const suffix of FILE_SUFFIXES) {
    const candidate = base === "" ? `__init__${suffix}` : `${base}/__init__${suffix}`;
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve a Python module specifier to a repo-relative path, or `undefined`
 * when it is external / unresolvable.
 */
export function resolvePythonImport(
  raw: string,
  fromFile: string,
  ctx: AnalyzerContext,
): string | undefined {
  const spec = raw.trim();
  if (spec === "") return undefined;

  const relative = parseRelative(spec);
  if (relative) {
    // Level 1 is the directory holding the importing file, each extra dot goes
    // one package further up.
    let base = dirOf(fromFile);
    for (let i = 1; i < relative.level; i++) {
      if (base === "") return undefined;
      base = dirOf(base);
    }
    const tail = relative.module.split(".").filter(Boolean).join("/");
    // `tail === ""` is a bare `from . import x`, i.e. the package itself.
    return tail === "" ? probe(base, ctx.files) : probe(joinPosix(base, tail), ctx.files);
  }

  const tail = spec.split(".").filter(Boolean).join("/");
  if (tail === "") return undefined;
  for (const root of PYTHON_SOURCE_ROOTS) {
    const hit = probe(joinPosix(root, tail), ctx.files);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Top-level distribution/module name behind an unresolved specifier, or
 * `undefined` for relative imports (which are repo-internal by definition, so a
 * miss means a missing file rather than an external dependency).
 *
 * Note this includes the standard library (`os`, `json`, …): from the graph's
 * point of view those are equally "code outside this repo".
 */
export function pythonExternalPackage(raw: string): string | undefined {
  const spec = raw.trim();
  if (spec === "" || spec.startsWith(".")) return undefined;
  const top = spec.split(".")[0];
  return top === "" ? undefined : top;
}
