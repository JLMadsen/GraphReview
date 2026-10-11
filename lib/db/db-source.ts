// A repo's pinned schema source file (DESIGN.md §6.13, pinned source): one
// path, chosen in the Data view, that replaces the schema catalog's
// auto-detection — for the analysed commit and for every review target.
// Kept in `kv` (`kv:db-source:<repoId>`), deleted with the repo.

import { readKv, writeKv } from "./kv";
import { run } from "./client";

export interface DbSourcePin {
  file: string;
  /** When it was chosen (ISO). */
  setAt: string;
}

const key = (repoId: string) => `db-source:${repoId}`;

export function readDbSource(repoId: string): DbSourcePin | null {
  const pin = readKv<DbSourcePin>(key(repoId));
  return pin && typeof pin.file === "string" && pin.file ? pin : null;
}

export function writeDbSource(repoId: string, file: string): DbSourcePin {
  const pin = { file, setAt: new Date().toISOString() };
  writeKv(key(repoId), pin);
  return pin;
}

export function clearDbSource(repoId: string): void {
  run(`DELETE FROM kv WHERE key = ?`, `kv:${key(repoId)}`);
}
