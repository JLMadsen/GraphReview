// `POST /api/jobs/[queue]/[id]/retry` — re-enqueues a finished job with the same data through its queue's own enqueue.

import { NextResponse } from "next/server";
import { retryJob, isJobQueue } from "@/lib/jobs/jobs-overview";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ queue: string; id: string }> }) {
  const { queue, id } = await params;
  if (!isJobQueue(queue)) return NextResponse.json({ error: "Unknown queue." }, { status: 404 });
  try {
    const result = await retryJob(queue, id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ outcome: result.outcome });
  } catch (err) {
    console.error(`POST /api/jobs/${queue}/${id}/retry failed:`, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed." }, { status: 500 });
  }
}
