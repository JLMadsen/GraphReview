// @ts-check

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Loaded from node_modules at runtime rather than bundled: tree-sitter
  // reads its .wasm files from disk next to the package, and simple-git
  // spawns `git`.
  serverExternalPackages: ["web-tree-sitter", "@vscode/tree-sitter-wasm", "simple-git"],
};

export default nextConfig;
