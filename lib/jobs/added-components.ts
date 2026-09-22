// Ephemeral, non-persisted counterpart to lib/jobs/diff-components.ts's
// `unmatchedFiles`: a PR can add files that have no `(:File)` node yet (the
// persisted graph only reflects the last analysis of the default branch —
// see analyze.ts), so they can't be resolved to a stored `Component`. This
// module turns those paths into folder-clustered "added components" and
// asks the AI provider for a one-sentence description each, exactly like
// the real labeling job (./label.ts) does for the persisted module tier —
// but for a handful of files, in one best-effort call, and never written to
// Neo4j. `app/api/repos/[repoId]/diff-impact/route.ts` runs this
// synchronously and the Graph tab renders the result as extra, green-styled
// nodes for the duration of that PR view only.
//
// Kept out of lib/jobs' barrel on purpose, like ./analyze.ts, ./label.ts and
// ./review.ts: it pulls in lib/ai, which the app bundle has no reason to
// carry just because a route imported `@/lib/jobs` to enqueue something.

import {
  clusterByFolderDepth,
  DEFAULT_MODULE_DEPTH,
} from "@/lib/analysis/graph-builder";
import { describeModules } from "@/lib/ai";
import type { AiProviderConfig, LabelInput, LabelModuleInput } from "@/lib/ai";
import { decrypt } from "@/lib/crypto";
import { getActiveAiProvider } from "@/lib/neo4j";

/** Sample paths sent per component — same budget as the real labeling job (./label.ts). */
const SAMPLE_FILES_PER_COMPONENT = 3;

export interface AddedComponent {
  /** `<repoId>:added:<name>` — a distinct id segment from analyze.ts's `<repoId>:module:<name>`, so this can never collide with (or be mistaken for) a persisted component. */
  id: string;
  name: string;
  filePaths: string[];
}

function addedComponentId(repoId: string, name: string): string {
  return `${repoId}:added:${name}`;
}

/**
 * Folder-clusters paths with no matching `(:File)` node into ephemeral
 * components, using the same clustering `analyzeRepo` uses for the real
 * module tier — just run over a handful of new paths instead of a whole
 * checkout, and never persisted.
 */
export function synthesizeAddedComponents(
  repoId: string,
  unmatchedFiles: readonly string[],
  moduleDepth: number = DEFAULT_MODULE_DEPTH
): AddedComponent[] {
  if (unmatchedFiles.length === 0) return [];
  const clusters = clusterByFolderDepth([...unmatchedFiles], moduleDepth);
  return clusters.map((cluster) => ({
    id: addedComponentId(repoId, cluster.name),
    name: cluster.name,
    filePaths: cluster.filePaths,
  }));
}

/**
 * Best-effort one-sentence description per synthesized component, via the
 * same `describeModules` call the real labeling job makes. Deliberately
 * never throws: an unconfigured or unreachable AI provider degrades to
 * undescribed components (still returned, still worth a green node) rather
 * than failing the whole diff-impact request over a label.
 */
export async function describeAddedComponents(
  repoName: string,
  components: readonly AddedComponent[]
): Promise<Map<string, string>> {
  const descriptions = new Map<string, string>();
  if (components.length === 0) return descriptions;

  let aiConfig: AiProviderConfig;
  try {
    const provider = await getActiveAiProvider();
    if (!provider?.baseUrl || !provider?.apiKeyEncrypted || !provider?.model) {
      return descriptions;
    }
    aiConfig = {
      baseUrl: provider.baseUrl,
      apiKey: decrypt(provider.apiKeyEncrypted as string),
      model: provider.model,
    };
  } catch {
    return descriptions;
  }

  const input: LabelInput = {
    repoName,
    modules: components.map(
      (c): LabelModuleInput => ({
        id: c.id,
        name: c.name,
        fileCount: c.filePaths.length,
        sampleFiles: c.filePaths.slice(0, SAMPLE_FILES_PER_COMPONENT),
        dependsOn: [],
      })
    ),
  };

  try {
    const result = await describeModules(aiConfig, input);
    for (const d of result.value) descriptions.set(d.id, d.description);
  } catch {
    /* Best-effort — see the doc comment above. */
  }
  return descriptions;
}
