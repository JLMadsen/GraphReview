/**
 * What a change does to the env catalog (DESIGN.md §6.15 §3–4): per name,
 * the reads, declarations and sets it adds, removes or changes, and four
 * certain findings — no model call:
 *
 *   undeclared-read       a new read with no fallback that nothing in scope declares or sets
 *   secret-to-client      a secret-looking name newly exposed to the browser
 *   committed-secret      a secret value newly committed (examples count only by value shape)
 *   declaration-removed   the last declaration or set of a name the head still reads
 *
 * The infra comparison's "env var no longer set" wins over the last one for
 * the same name (no duplicates).
 */
import type { ChangedLines } from "../compare";
import type { InfraFinding } from "../infra/types";
import { isPlaceholder, isSecretName, isSecretValue, unquote } from "./secret";
import type { EnvCatalog, EnvCellDelta, EnvChange, EnvChangeEntry, EnvFinding, EnvRead, EnvSet, EnvVar } from "./types";

const MAX_DELTAS = 40;

const setText = (s: EnvSet) => (s.ref ? `↗ ${s.ref}` : s.value ?? "");
const declText = (v: EnvVar) =>
  v.decls
    .filter((d) => d.via !== "example")
    .map((d) => `${d.via}${d.type ? ` ${d.type}` : ""}${d.default !== undefined ? `=${d.default}` : ""}${d.optional ? "?" : ""}`)
    .join(", ");

function readKey(r: EnvRead): string {
  return `${r.file}`;
}

/** Reads on lines the change added; a file the change didn't touch adds none. */
function addedReads(head: EnvVar, base: EnvVar | undefined, changed: ReadonlyMap<string, ChangedLines>): EnvRead[] {
  const baseCount = new Map<string, number>();
  for (const r of base?.reads ?? []) baseCount.set(readKey(r), (baseCount.get(readKey(r)) ?? 0) + 1);
  const out: EnvRead[] = [];
  const byFile = new Map<string, EnvRead[]>();
  for (const r of head.reads) (byFile.get(readKey(r)) ?? byFile.set(readKey(r), []).get(readKey(r))!).push(r);
  for (const [file, reads] of byFile) {
    const lines = changed.get(file);
    if (!lines) continue;
    const onChanged = reads.filter((r) => lines.added.has(r.line));
    if (onChanged.length && (reads.length > (baseCount.get(file) ?? 0) || !base)) out.push(...onChanged);
  }
  return out;
}

export function compareEnv(
  base: EnvCatalog,
  head: EnvCatalog,
  changed: ReadonlyMap<string, ChangedLines>,
  infraFindings: readonly InfraFinding[] = []
): EnvChange {
  const baseBy = new Map(base.vars.map((v) => [v.name, v]));
  const headBy = new Map(head.vars.map((v) => [v.name, v]));
  const infraUnset = new Set(infraFindings.filter((f) => f.rule === "env-unset" && f.name).map((f) => f.name!));
  const changes: EnvChangeEntry[] = [];
  const findings: EnvFinding[] = [];
  const touched = (file: string, line?: number) => {
    const c = changed.get(file);
    return Boolean(c && (line === undefined || c.added.has(line)));
  };

  for (const name of new Set([...baseBy.keys(), ...headBy.keys()])) {
    const b = baseBy.get(name);
    const h = headBy.get(name);
    const v = (h ?? b)!;
    const deltas: EnvCellDelta[] = [];
    const keys: string[] = [];
    const finding = (f: Omit<EnvFinding, "key" | "name">) => {
      const key = `env:${f.rule}:${name}${f.rule === "committed-secret" ? `:${f.file}:${f.line ?? ""}` : ""}`;
      if (findings.some((x) => x.key === key)) return;
      findings.push({ key, name, ...f });
      keys.push(key);
    };

    // Reads.
    const added = h ? addedReads(h, b, changed) : [];
    for (const r of added) deltas.push({ where: "read", after: `${r.file}:${r.line}`, file: r.file, line: r.line });
    if (b) {
      const headFiles = new Set(h?.reads.map((r) => r.file) ?? []);
      for (const r of b.reads) if (!headFiles.has(r.file) && changed.has(r.file)) deltas.push({ where: "read", before: `${r.file}:${r.line}`, file: r.file });
    }
    // Declarations (schemas; examples show as their own column below).
    const before = b ? declText(b) : "";
    const after = h ? declText(h) : "";
    if (before !== after) deltas.push({ where: "declared", ...(before ? { before } : {}), ...(after ? { after } : {}) });
    // Sets, per id.
    const baseSets = new Map((b?.sets ?? []).map((s) => [s.id, s]));
    const headSets = new Map((h?.sets ?? []).map((s) => [s.id, s]));
    for (const [id, s] of headSets) {
      const old = baseSets.get(id);
      if (!old) deltas.push({ where: s.target, after: setText(s), file: s.file, line: s.line });
      else if (setText(old) !== setText(s)) deltas.push({ where: s.target, before: setText(old), after: setText(s), file: s.file, line: s.line });
    }
    for (const [id, s] of baseSets) if (!headSets.has(id)) deltas.push({ where: s.target, before: setText(s), file: s.file, line: s.line });

    const newTags = h ? h.tags.filter((t) => !b?.tags.includes(t)) : [];
    if (deltas.length === 0 && newTags.length === 0) continue;

    if (h) {
      // 1. A new read nothing declares.
      const undeclared = added.find((r) => r.gap === "undeclared");
      if (undeclared && !infraUnset.has(name)) {
        finding({
          rule: "undeclared-read",
          file: undeclared.file,
          line: undeclared.line,
          assessment: "concern",
          summary: `${undeclared.file} now reads ${name}, which nothing declares or sets`,
          rationale:
            `Line ${undeclared.line} reads the env var ${name} without a fallback, and nothing in its scope declares it (no env schema, no .env.example key) ` +
            `or sets it (no .env file, Compose service, CI job, framework config or workload env). Whoever runs or deploys this next has no way to know it's needed; ` +
            `at runtime it will be undefined. Add it to the env schema or .env.example, or give the read a fallback.`,
        });
      }
      // 2. A secret-looking name newly exposed to the browser.
      const wasClient = Boolean(b?.clientVia);
      if (h.clientVia && !wasClient && isSecretName(name)) {
        const at =
          h.sets.find((s) => s.client && touched(s.file, s.line)) ??
          h.sets.find((s) => touched(s.file, s.line)) ??
          h.decls.find((d) => touched(d.file, d.line)) ??
          added[0] ??
          h.sets[0] ??
          h.decls[0] ??
          h.reads[0];
        if (at) {
          finding({
            rule: "secret-to-client",
            file: at.file,
            line: at.line,
            assessment: "defect",
            summary: `${name} looks like a secret and is now exposed to the browser`,
            rationale:
              `${name} is named like a secret, and this change exposes it to client code (${h.clientVia}). Frameworks inline such values into the JavaScript bundle ` +
              `at build time, so anyone who loads the page can read it. Keep the secret server-side and expose only a public counterpart, if one exists.`,
          });
        }
      }
      // 3. A secret value newly committed.
      for (const s of h.sets) {
        if (s.value === undefined || s.interpolated) continue;
        const old = baseSets.get(s.id);
        if (old && old.value === s.value) continue;
        const value = unquote(s.value);
        if (isPlaceholder(value)) continue;
        const shaped = isSecretValue(value);
        const example = s.target === "example";
        if (!shaped && (example || !isSecretName(name))) continue;
        finding({
          rule: "committed-secret",
          file: s.file,
          line: s.line,
          assessment: "defect",
          summary: `${s.file} commits a value for ${name} that looks like a real secret`,
          rationale:
            `This change ${old ? "changes" : "adds"} the value of ${name} in ${s.file} (line ${s.line}), and it ${shaped ? "is shaped like a credential (a known token prefix, a password in a URL, or a long random string)" : "is a non-placeholder value for a secret-looking name"}. ` +
            `Anything committed stays in the repository's history, even after it is removed. Rotate it, and set it outside the repo (a CI secret, the host's env, a git-ignored .env).`,
        });
      }
      for (const r of added) {
        if (r.fallback === undefined || isPlaceholder(r.fallback) || !(isSecretValue(r.fallback) || (isSecretName(name) && r.fallback !== "…" && r.fallback.length >= 12))) continue;
        finding({
          rule: "committed-secret",
          file: r.file,
          line: r.line,
          assessment: "defect",
          summary: `${r.file} hard-codes a fallback for ${name} that looks like a real secret`,
          rationale: `Line ${r.line} falls back to a literal when ${name} isn't set, and the literal looks like a real credential. It is committed to the repository, and it is what runs whenever the env var is missing. Rotate it and remove the fallback.`,
        });
      }
      // 4. A declaration or set removed while the head still reads it.
      if (b && !infraUnset.has(name) && !keys.some((k) => k.startsWith("env:undeclared-read"))) {
        const addedSet = new Set(added);
        const still = h.reads.find((r) => r.gap === "undeclared" && !addedSet.has(r));
        const baseRead = still && b.reads.find((r) => r.file === still.file);
        const removedDecl = b.decls.find((d) => !h.decls.some((x) => x.file === d.file && x.via === d.via));
        const removedSet = b.sets.find((s) => !headSets.has(s.id));
        const removed = removedDecl ?? removedSet;
        if (still && removed && (!baseRead || baseRead.gap !== "undeclared")) {
          finding({
            rule: "declaration-removed",
            file: removed.file,
            line: removed.line,
            assessment: "concern",
            summary: `${name} was removed from ${removed.file}, but ${still.file} still reads it`,
            rationale:
              `This change removes the last ${removedDecl ? "declaration" : "setting"} of ${name} in scope (${removed.file}, line ${removed.line}), and ${still.file} (line ${still.line}) ` +
              `still reads it without a fallback. At runtime it will be undefined, and nothing tells the next person it is needed. Remove the read too, or keep the declaration.`,
          });
        }
      }
    }

    changes.push({
      name,
      status: !b ? "new" : !h ? "gone" : "changed",
      variable: v,
      deltas: deltas.slice(0, MAX_DELTAS),
      newTags,
      ...(keys.length ? { findings: keys } : {}),
    });
  }

  const order = { new: 1, gone: 0, changed: 2 } as const;
  changes.sort((a, b) => Number(!a.findings) - Number(!b.findings) || order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  return {
    changes,
    findings,
    counts: {
      new: changes.filter((c) => c.status === "new").length,
      gone: changes.filter((c) => c.status === "gone").length,
      changed: changes.filter((c) => c.status === "changed").length,
      findings: findings.length,
    },
    total: head.vars.length,
  };
}
