// Finding the changed UI components of a target, without running anything
// (DESIGN.md §6.9). Runs when a PR or ref comparison loads, so the Graph tab
// can say "N components changed" before anyone opens a file: both versions
// of each changed JS/TS file are parsed (lib/preview/symbols.ts), and only
// components are kept — plain function changes stay in the per-file dialog.
// No Docker, no model call.
//
// Kept out of lib/jobs' barrel: it pulls in lib/analysis.

import { UnrecoverableError } from "bullmq";
import { getRepoById } from "@/lib/neo4j";
import { readFileAt } from "@/lib/preview/checkout";
import { detectChangedSymbols } from "@/lib/preview/symbols";
import type { PreviewScanResult } from "@/lib/preview/types";
import type { JobLogger } from "./analyze";
import { resolveCommits } from "./preview";
import type { PreviewScanJobData } from "./preview-queue";

/** Only files that can hold JSX are worth parsing for components. */
const COMPONENT_FILE = /\.(tsx|jsx|js|mjs)$/i;
const MAX_FILES = 200;

export async function runPreviewScanJob(data: PreviewScanJobData, log: JobLogger): Promise<PreviewScanResult> {
  const repo = await getRepoById(data.repoId);
  if (!repo) throw new UnrecoverableError(`Repo ${data.repoId} not found.`);

  const { repoDir, baseSha, headSha, changedFiles } = await resolveCommits(repo, data.target, log);
  const candidates = changedFiles.filter((f) => COMPONENT_FILE.test(f) && !f.endsWith(".d.ts")).slice(0, MAX_FILES);

  const files: PreviewScanResult["files"] = [];
  for (const filePath of candidates) {
    const [before, after] = await Promise.all([
      readFileAt(repoDir, baseSha, filePath),
      readFileAt(repoDir, headSha, filePath),
    ]);
    if (before === null && after === null) continue;
    try {
      const { runnable } = await detectChangedSymbols(filePath, "node", before, after);
      const components = runnable
        .filter((s) => s.kind === "component")
        .map(({ name, change, line, via }) => ({ name, change, line, ...(via ? { via } : {}) }));
      if (components.length > 0) files.push({ filePath, components });
    } catch (error) {
      log(`could not parse ${filePath}: ${(error as Error).message}`);
    }
  }
  log(`${files.reduce((n, f) => n + f.components.length, 0)} changed component(s) in ${files.length} of ${candidates.length} file(s)`);
  return { baseSha, headSha, files };
}
