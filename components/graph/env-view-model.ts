// Pure helpers for the Env view (DESIGN.md §6.15 §5): tag styles, the
// matrix's cells and the folder a read belongs to.

import type { EnvChange, EnvSet, EnvTag, EnvTarget, EnvVar } from "./env-types";

export const TAG_STYLES: Record<EnvTag, { label: string; className: string; title: string }> = {
  undeclared: { label: "undeclared", className: "bg-warning/15 text-warning", title: "Read without a fallback, and nothing in its scope declares it (no env schema, no .env.example key) or sets it" },
  "not-set": { label: "not set", className: "bg-secondary text-muted-foreground", title: "Declared, but no committed source gives it a value in the reading code's scope — it comes from somewhere outside the repo" },
  "set-not-read": { label: "set, not read", className: "bg-secondary text-muted-foreground", title: "A source sets it, but no code reads it and no schema declares it" },
  "maybe-set": { label: "maybe set", className: "bg-secondary text-muted-foreground", title: "Only references set it (a CI secret, a k8s Secret, a template, the host's env): the value isn't in the repo" },
  secret: { label: "secret", className: "bg-violet-500/15 text-violet-400", title: "Looks like a secret, by its name or by a committed value's shape" },
  client: { label: "client", className: "bg-sky-500/15 text-sky-400", title: "Exposed to the browser bundle" },
  "undefined-in-client": { label: "undefined in client", className: "bg-warning/15 text-warning", title: "Read in client code without the client prefix — Next and Vite replace it with undefined there" },
  platform: { label: "platform", className: "bg-secondary text-muted-foreground", title: "Provided by the runtime (NODE_ENV, PORT, CI, …)" },
};

/** The tags worth a chip in the row (platform greys the whole row instead). */
export const ROW_TAGS: readonly EnvTag[] = ["secret", "client", "undeclared", "undefined-in-client", "not-set", "maybe-set", "set-not-read"];

/** The folder a file's code belongs to, two levels deep (`apps/web`, `lib/auth`), like the analysis's default module depth. */
export function moduleOf(file: string): string {
  const parts = file.split("/");
  parts.pop();
  return parts.slice(0, 2).join("/") || "(root)";
}

/** Where a set's scope reaches, for the scope filter: does it cover `root`? */
const isUnder = (file: string, folder: string) => folder === "" || file === folder || file.startsWith(`${folder}/`);

/** A variable belongs to a scope when it is read, declared or set inside it. */
export function inScope(v: EnvVar, root: string | null): boolean {
  if (root === null) return true;
  return v.reads.some((r) => isUnder(r.file, root)) || v.decls.some((d) => isUnder(d.file, root)) || v.sets.some((s) => isUnder(s.file, root) || s.scope.some((f) => f !== "" && isUnder(f, root)));
}

export interface EnvCell {
  sets: EnvSet[];
  /** No set of its own, but the folder's `.env` gives it one (`↳ default`). */
  inherited?: EnvSet;
}

/** What one target column shows for a variable. */
export function cellOf(v: EnvVar, target: EnvTarget, root: string | null): EnvCell {
  const sets = v.sets.filter((s) => s.target === target.id && (root === null || isUnder(s.file, root) || s.scope.some((f) => isUnder(f, root))));
  if (sets.length || target.kind !== "dotenv" || target.id === "default") return { sets };
  const inherited = v.sets.find((s) => s.target === "default" && (root === null || isUnder(s.file, root)));
  return inherited ? { sets, inherited } : { sets };
}

/** Names of the variables the change touches, for "N changed". */
export function changedNames(change: EnvChange | undefined): ReadonlySet<string> {
  return new Set(change?.changes.map((c) => c.name) ?? []);
}

/** Whether the diff changed env vars — the left column's section shows only then. */
export const envChanged = (change: EnvChange | undefined): change is EnvChange => Boolean(change && (change.changes.length > 0 || change.findings.length > 0));
