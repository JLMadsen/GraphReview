// Where GraphReview keeps its state on this machine.
//
// Everything the app writes lives under one folder: the SQLite database, the
// clone cache for GitHub/GitLab repos, and the generated credential key.
// `GRAPHREVIEW_HOME` overrides it; otherwise an installed copy uses
// `~/.graphreview`, and a source checkout under `npm run dev` uses `.data/`
// in the checkout so development never touches a real install's database.
//
// Server-only (reads env, touches the filesystem).

import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let cached: string | undefined;

/** The data folder, created on first use. */
export function getDataDir(): string {
  if (cached) return cached;
  const explicit = process.env.GRAPHREVIEW_HOME;
  const dir = explicit
    ? path.resolve(explicit)
    : process.env.NODE_ENV === "development"
      ? path.resolve(process.cwd(), ".data")
      : path.join(os.homedir(), ".graphreview");
  mkdirSync(dir, { recursive: true });
  cached = dir;
  return dir;
}

/** Path of the SQLite database file. */
export function getDatabasePath(): string {
  return path.join(getDataDir(), "graphreview.db");
}
