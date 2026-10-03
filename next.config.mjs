// @ts-check

/** @type {import("next").NextConfig} */
const nextConfig = {
  // A running `npx graphreview` from this checkout serves `.next`; a check
  // build into the same folder swaps the build out from under it (pages then
  // reference scripts that no longer exist). GRAPHREVIEW_DIST_DIR builds
  // somewhere else instead — see AGENTS.md.
  distDir: process.env.GRAPHREVIEW_DIST_DIR || ".next",
  // Loaded from node_modules at runtime rather than bundled: tree-sitter
  // reads its .wasm files from disk next to the package, and simple-git
  // spawns `git`.
  serverExternalPackages: ["web-tree-sitter", "@vscode/tree-sitter-wasm", "simple-git"],
};

export default nextConfig;
