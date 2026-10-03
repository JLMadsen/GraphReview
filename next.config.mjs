// @ts-check

import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/** @type {(phase: string) => import("next").NextConfig} */
const nextConfig = (phase) => ({
  // `npx graphreview` / `npm start` serve the production build in `.next`.
  // Anything else building in the same checkout must not write there, or a
  // running copy is left serving pages whose scripts no longer exist:
  // `next dev` always uses `.next-dev`, and GRAPHREVIEW_DIST_DIR sends a
  // check build elsewhere (see AGENTS.md).
  distDir:
    process.env.GRAPHREVIEW_DIST_DIR || (phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next"),
  // Loaded from node_modules at runtime rather than bundled: tree-sitter
  // reads its .wasm files from disk next to the package, and simple-git
  // spawns `git`.
  serverExternalPackages: ["web-tree-sitter", "@vscode/tree-sitter-wasm", "simple-git"],
});

export default nextConfig;
