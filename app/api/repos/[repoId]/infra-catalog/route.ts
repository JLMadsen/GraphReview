// GET /api/repos/[repoId]/infra-catalog
//
// The Infra view (DESIGN.md §6.12): the infrastructure the repo's analysed
// commit declares — Terraform / OpenTofu, Nomad, Kubernetes (manifests,
// Kustomize), Helm and Dockerfiles — with its links to the code (deploys,
// env vars, routes, ports). Built by static analysis during the analysis
// job; read-only and free. A review target's infra change rides on the
// target graph (`/target-graph`).

import { NextResponse } from "next/server";
import { getRepoById, readInfraCatalog } from "@/lib/db";
import { EMPTY_INFRA_CATALOG } from "@/lib/analysis/infra/types";
import type { InfraCatalogResponseDTO } from "@/components/graph/infra-types";
import { apiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const stored = readInfraCatalog(repoId);
    const body: InfraCatalogResponseDTO = stored
      ? { state: "ready", sha: stored.sha, computedAt: stored.computedAt, ...stored.catalog }
      : { state: "none", ...EMPTY_INFRA_CATALOG };
    return NextResponse.json(body);
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/infra-catalog failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the infra catalog.", 500);
  }
}
