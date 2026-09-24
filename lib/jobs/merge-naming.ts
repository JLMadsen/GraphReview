// AI naming of a merged feature module (DESIGN.md §6.3), run right after a
// suggestion is accepted. Gathers the generous context lib/ai/merge-name.ts
// asks for — member files with their declarations, route hints, the imports
// between member folders and a README excerpt — makes one model call and
// writes the name and description onto the module.
//
// Kept out of lib/jobs' barrel (it pulls in lib/ai). Best-effort: when no AI
// provider is configured or the reply is unusable, the heuristic name stays.

import { nameMergeGroup } from "@/lib/ai";
import type { AiProviderConfig, MergeNameFile, TokenUsage } from "@/lib/ai";
import { decrypt } from "@/lib/crypto";
import {
  getActiveAiProvider,
  getComponentById,
  getRepoById,
  getStoredImportGraph,
  listFilesByComponentId,
  upsertComponent,
} from "@/lib/neo4j";
import type { ComponentRecord } from "@/lib/neo4j";
import type { JobLogger } from "./analyze";
import { readReadmeSnippet } from "./label";
import { MergeActionError } from "./merges";
import { folderOfPattern, isUnderFolder } from "./ownership";
import { extractDeclarations, readRepoFile, sourceDir } from "./review-context";

const MAX_FILES = 80;
const MAX_DECLARATIONS_PER_FILE = 12;

/** The active provider's config, or `null` when it isn't fully configured. */
export async function loadAiConfigOrNull(): Promise<AiProviderConfig | null> {
  const provider = await getActiveAiProvider();
  if (!provider?.baseUrl || !provider.apiKeyEncrypted || !provider.model) return null;
  try {
    return { baseUrl: provider.baseUrl, apiKey: decrypt(provider.apiKeyEncrypted), model: provider.model };
  } catch {
    return null;
  }
}

/**
 * The URL a Next.js App Router page or route handler serves, or a Pages
 * Router page: `app/map/page.tsx` → `/map`, `src/app/api/map/route.ts` →
 * `/api/map`, `pages/map/index.tsx` → `/map`. `undefined` for anything else.
 */
export function routeHint(filePath: string): string | undefined {
  const path = filePath.replace(/^src\//, "");
  const segments = path.split("/");
  const file = segments.pop() ?? "";
  const stem = file.replace(/\.[^.]+$/, "");

  if (segments[0] === "app" && (stem === "page" || stem === "route")) {
    const parts = segments.slice(1).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    return `/${parts.join("/")}`;
  }
  if (segments[0] === "pages" && /\.(tsx?|jsx?)$/.test(file) && !stem.startsWith("_")) {
    const parts = [...segments.slice(1), ...(stem === "index" ? [] : [stem])];
    return `/${parts.join("/")}`;
  }
  return undefined;
}

/** The member folder a file falls under (longest match), for aggregating imports per folder pair. */
function memberFolderOf(filePath: string, folders: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const dir of folders) {
    if (isUnderFolder(filePath, dir) && (!best || dir.length > best.length)) best = dir;
  }
  return best;
}

export interface NameResult {
  component: ComponentRecord;
  /** `false` when no provider is configured or the reply had no usable name. */
  named: boolean;
  usage?: TokenUsage;
}

export async function nameMergedModuleWithAi(
  repoId: string,
  componentId: string,
  log: JobLogger
): Promise<NameResult> {
  const component = await getComponentById(componentId);
  if (!component || component.repoId !== repoId || component.origin !== "merge") {
    throw new MergeActionError("No such merged module.", 404);
  }
  const config = await loadAiConfigOrNull();
  if (!config) return { component, named: false };

  const repo = await getRepoById(repoId);
  if (!repo) throw new MergeActionError("No such repo.", 404);

  const filePaths = (await listFilesByComponentId(component.id)).map((f) => f.path);
  const dir = await sourceDir(repo);
  const files: MergeNameFile[] = [];
  for (const path of filePaths.slice(0, MAX_FILES)) {
    const source = dir ? await readRepoFile(dir, path) : null;
    files.push({
      path,
      route: routeHint(path),
      declarations: source
        ? extractDeclarations(source)
            .filter((d) => d.indent === 0)
            .slice(0, MAX_DECLARATIONS_PER_FILE)
            .map((d) => d.signature)
        : [],
    });
  }
  // Paths beyond the cap still count in the prompt's "+N more".
  for (const path of filePaths.slice(MAX_FILES)) files.push({ path, declarations: [] });

  const folders = component.pathPatterns.map(folderOfPattern).filter((d): d is string => d !== null);
  const { edges } = await getStoredImportGraph(repoId);
  const owned = new Set(filePaths);
  const pairCounts = new Map<string, number>();
  for (const { from, to } of edges) {
    if (!owned.has(from) || !owned.has(to)) continue;
    const a = memberFolderOf(from, folders) ?? from;
    const b = memberFolderOf(to, folders) ?? to;
    if (a === b) continue;
    const key = `${a}\u0000${b}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const imports = [...pairCounts]
    .map(([key, count]) => {
      const [from, to] = key.split("\u0000");
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);

  const result = await nameMergeGroup(config, {
    repoName: repo.name,
    readme: await readReadmeSnippet(repo, log),
    members: component.pathPatterns,
    files,
    imports,
    proposedName: component.name,
  });
  log(
    `named merged module: ${result.usage.promptTokens}+${result.usage.completionTokens} token(s)` +
      (result.parseFailed ? " (reply unusable — keeping the heuristic name)" : ` → "${result.name ?? component.name}"`)
  );
  if (result.parseFailed) return { component, named: false, usage: result.usage };

  const updated = await upsertComponent({
    ...component,
    name: result.name ?? component.name,
    description: result.description ?? component.description,
  });
  return { component: updated, named: true, usage: result.usage };
}
