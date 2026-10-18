// The usages dialog's content (DESIGN.md §6.28): one declaration's source
// and every place the repo uses it, each as a few lines of code around the
// use — read at the commit the usages were found at.
//
// Where it is used comes from the analysis (lib/db/code-links.ts); the text
// from `readFileAtCommit` (pr-context.ts): git in the checkout or the app's
// clone, else the host's API, kept in memory by commit. Reading
// is capped — the files nearest the top of the list first — so a function
// used everywhere doesn't turn one request into hundreds of reads.

import type { RepoRecord } from "@/lib/db";
import { readCodeLinks, readCodeUsages } from "@/lib/db";
import type { CodeUsagesResponseDTO, UsageBlock } from "@/components/graph/code-links";
import { readFileAtCommit } from "./pr-context";

/** Lines shown above and below each use. */
const CONTEXT = 2;
/** Files read for snippets; the rest are listed with their lines only. */
const MAX_FILES = 40;
/** Uses shown per file. */
const MAX_SITES_PER_FILE = 25;
/** The declaration's own source is cut off past this many lines. */
const MAX_SOURCE_LINES = 200;
const READ_CONCURRENCY = 6;

/** The file at the commit (cached by commit, clone before API — pr-context.ts); `null` when only another commit has it. */
async function readAt(repo: RepoRecord, sha: string, file: string): Promise<string | null> {
  const whole = await readFileAtCommit(repo, sha, file);
  return whole?.source === "commit" ? whole.text : null;
}

/** The uses of one file as blocks of code: each use with `CONTEXT` lines around it, overlapping windows merged. */
export function usageBlocks(lines: readonly string[], uses: readonly number[]): UsageBlock[] {
  const blocks: UsageBlock[] = [];
  for (const use of uses) {
    if (use < 1 || use > lines.length) continue;
    const from = Math.max(1, use - CONTEXT);
    const to = Math.min(lines.length, use + CONTEXT);
    const last = blocks[blocks.length - 1];
    if (last && from <= last.from + last.lines.length) {
      const lastTo = last.from + last.lines.length - 1;
      if (to > lastTo) last.lines.push(...lines.slice(lastTo, to));
      last.uses.push(use);
    } else {
      blocks.push({ from, lines: lines.slice(from - 1, to), uses: [use] });
    }
  }
  return blocks;
}

const splitLines = (text: string) => text.replace(/\r?\n$/, "").split(/\r?\n/);

export async function loadCodeUsages(repo: RepoRecord, sha: string, id: string): Promise<CodeUsagesResponseDTO> {
  const hash = id.indexOf("#");
  const declFile = hash > 0 ? id.slice(0, hash) : "";
  const stored = declFile ? readCodeLinks(repo.id, sha, declFile) : null;
  const usages = readCodeUsages(repo.id, sha, id);
  if (stored === null || usages === null) return { state: "none" };
  const decl = stored.decls.find((d) => d.id === id);
  if (!decl) return { state: "missing" };

  const shown = usages.slice(0, MAX_FILES);
  const texts = new Map<string, string[] | null>();
  const wanted = [...new Set([declFile, ...shown.map((f) => f.file)])];
  for (let i = 0; i < wanted.length; i += READ_CONCURRENCY) {
    await Promise.all(
      wanted.slice(i, i + READ_CONCURRENCY).map(async (file) => {
        const text = await readAt(repo, sha, file).catch(() => null);
        texts.set(file, text === null ? null : splitLines(text));
      })
    );
  }

  const declLines = texts.get(declFile) ?? null;
  const end = Math.min(decl.endLine, decl.line + MAX_SOURCE_LINES - 1);
  return {
    state: "ready",
    sha,
    decl: {
      ...decl,
      file: declFile,
      source: declLines ? declLines.slice(decl.line - 1, end) : null,
      sourceCut: declLines ? Math.max(0, Math.min(decl.endLine, declLines.length) - end) : 0,
    },
    total: usages.reduce((n, f) => n + f.lines.length, 0),
    files: usages.map((f, i) => {
      const lines = i < MAX_FILES ? texts.get(f.file) : undefined;
      const sites = f.lines.slice(0, MAX_SITES_PER_FILE);
      return {
        file: f.file,
        names: f.names,
        lines: f.lines,
        blocks: lines ? usageBlocks(lines, sites) : null,
        moreSites: f.lines.length - sites.length,
      };
    }),
  };
}
