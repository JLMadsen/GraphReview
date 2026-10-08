// GET /api/repos/[repoId]/api-catalog
//
// The API view (DESIGN.md §6.11): every endpoint of the repo's analysed
// commit — HTTP routes, server actions, tRPC procedures, GraphQL fields —
// built by static analysis during the analysis job, with shapes a model
// inferred on request (✦) filled in. Read-only and free.

import { NextResponse } from "next/server";
import { getActiveAiProvider, getRepoById } from "@/lib/db";
import { readServedApiCatalog } from "@/lib/jobs/api-catalog";
import type { ApiCatalogResponseDTO } from "@/components/graph/api-types";
import { apiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const provider = await getActiveAiProvider();
    const aiConfigured = Boolean(provider?.baseUrl && provider.apiKeyEncrypted && provider.model);
    const served = readServedApiCatalog(repoId);
    const body: ApiCatalogResponseDTO = served
      ? { state: "ready", sha: served.sha, computedAt: served.computedAt, ...served.catalog, aiConfigured }
      : { state: "none", endpoints: [], specs: [], frameworks: [], unresolvedMounts: 0, aiConfigured };
    return NextResponse.json(body);
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/api-catalog failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the endpoint catalog.", 500);
  }
}
