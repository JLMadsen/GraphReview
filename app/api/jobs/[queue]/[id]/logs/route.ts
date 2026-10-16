// `GET /api/jobs/[queue]/[id]/logs` — the newest 200 lines of a job's log.

import { NextResponse } from "next/server";
import { isJobQueue, readJobLogs } from "@/lib/jobs/jobs-overview";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ queue: string; id: string }> }) {
  const { queue, id } = await params;
  if (!isJobQueue(queue)) return NextResponse.json({ error: "Unknown queue." }, { status: 404 });
  const logs = readJobLogs(queue, id);
  if (!logs) return NextResponse.json({ error: "No such job." }, { status: 404 });
  return NextResponse.json({ logs });
}
