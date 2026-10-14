// GET /api/repos/[repoId]/env-catalog
//
// The Env view (DESIGN.md §6.15): every env var name the repo's analysed
// commit reads, declares or sets, per environment, with the committed
// values. Built by static analysis during the analysis job; read-only and
// free. A review target's env change rides on the target graph
// (`/target-graph`).

import { NextResponse } from "next/server";
import { getFileOwnerMap, getRepoById, listComponentsByRepoId, readEnvCatalog } from "@/lib/db";
import { ownerLookup } from "@/lib/jobs/target-graph";
import { EMPTY_ENV_CATALOG, type EnvCatalog } from "@/lib/analysis/env/types";
import type { EnvCatalogResponseDTO } from "@/components/graph/env-types";
import { apiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const stored = readEnvCatalog(repoId);
    const body: EnvCatalogResponseDTO = stored
      ? { state: "ready", sha: stored.sha, computedAt: stored.computedAt, ...stored.catalog, fileComponents: await componentsOfReads(repoId, stored.catalog) }
      : { state: "none", ...EMPTY_ENV_CATALOG, fileComponents: {} };
    return NextResponse.json(body);
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/env-catalog failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the env catalog.", 500);
  }
}

/** The component owning each file that reads an env var, for "Read by" (looked up now, so a re-clustering shows without a re-analysis). */
async function componentsOfReads(repoId: string, catalog: EnvCatalog): Promise<EnvCatalogResponseDTO["fileComponents"]> {
  const [owners, components] = await Promise.all([getFileOwnerMap(repoId), listComponentsByRepoId(repoId)]);
  const ownerOf = ownerLookup(owners);
  const nameOf = new Map(components.map((c) => [c.id, c.name]));
  const out: EnvCatalogResponseDTO["fileComponents"] = {};
  for (const v of catalog.vars) {
    for (const r of v.reads) {
      if (r.host || out[r.file]) continue;
      const id = ownerOf(r.file);
      if (id && nameOf.has(id)) out[r.file] = { id, name: nameOf.get(id)! };
    }
  }
  return out;
}
