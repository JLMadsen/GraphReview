// `POST /api/jobs/seen` { jobs: [{ queue, id }] } — marks failures seen,
// which clears them from the header's red count (DESIGN.md §6.20 §2).

import { NextResponse } from "next/server";
import { z } from "zod";
import { markJobsSeen } from "@/lib/jobs/jobs-overview";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ jobs: z.array(z.object({ queue: z.string(), id: z.string() })).max(500) });

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Body must be { jobs: [{ queue, id }] }." }, { status: 400 });
  return NextResponse.json({ marked: markJobsSeen(parsed.data.jobs) });
}
