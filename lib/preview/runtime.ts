// Which sandbox runtime a file needs. Pure, so the Graph tab can decide
// whether to offer a preview without a round trip.

import type { PreviewRuntime } from "./types";

const NODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** `"node"`, `"python"`, or `null` when previews don't support the file's language. */
export function runtimeForPath(filePath: string): PreviewRuntime | null {
  const lower = filePath.toLowerCase();
  if (/\.d\.[cm]?ts$/.test(lower)) return null;
  const dot = lower.lastIndexOf(".");
  const ext = dot > lower.lastIndexOf("/") ? lower.slice(dot) : "";
  if (NODE_EXTENSIONS.has(ext)) return "node";
  if (ext === ".py") return "python";
  return null;
}
