// `POST /api/jobs/[queue]/[id]/cancel` — cancels a review or app-map job through its queue's own cancellation; 409 for queues without one.

import { NextResponse } from "next/server";
import { cancelJob, isJobQueue } from "@/lib/jobs/jobs-overview";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ queue: string; id: string }> }) {
  const { queue, id } = await params;
  if (!isJobQueue(queue)) return NextResponse.json({ error: "Unknown queue." }, { status: 404 });
  try {
    const result = await cancelJob(queue, id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ outcome: result.outcome });
  } catch (err) {
    console.error(`POST /api/jobs/${queue}/${id}/cancel failed:`, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed." }, { status: 500 });
  }
}
