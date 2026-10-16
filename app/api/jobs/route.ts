// `GET /api/jobs?repo=&state=` — every background job across the six
// queues (DESIGN.md §6.20 §5), with queue positions for waiting rows.

import { NextResponse } from "next/server";
import { listJobs } from "@/lib/jobs/jobs-overview";
import type { JobsResponse } from "@/components/jobs/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    const body = await listJobs({ repoId: params.get("repo") || undefined });
    const state = params.get("state");
    if (state === "active") body.jobs = body.jobs.filter((j) => j.state === "running" || j.state === "queued");
    else if (state === "failed") body.jobs = body.jobs.filter((j) => j.state === "failed");
    return NextResponse.json(body satisfies JobsResponse);
  } catch (err) {
    console.error("GET /api/jobs failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not read the jobs." }, { status: 500 });
  }
}
