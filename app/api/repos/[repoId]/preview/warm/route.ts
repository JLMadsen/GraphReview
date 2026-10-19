// Getting a target's previews ready before anyone presses Run (DESIGN.md §6.9,
// "Ahead of time").
//
//   POST /api/repos/[repoId]/preview/warm  { prNumber | baseRef+headRef }
//        queues the warm-up (checkouts, dependencies, warm sessions);
//        repeats within a few minutes are dropped
//
// Sent when the before/after list or a file's Before / after tab opens: the
// scan already warms a target up once, but its sessions close after 5 idle
// minutes. A POST, since it has side effects (DESIGN.md §6.26 §3).

import { NextResponse } from "next/server";
import { z } from "zod";
import { gitRefSchema } from "../../../_shared";
import { enqueuePreviewWarm, type ReviewTarget } from "@/lib/jobs";
import { getRepoById } from "@/lib/db";

export const dynamic = "force-dynamic";

const targetSchema = z.object({
  prNumber: z.coerce.number().int().positive().optional(),
  baseRef: gitRefSchema.optional(),
  headRef: gitRefSchema.optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const parsed = targetSchema.safeParse(await request.json().catch(() => undefined));
  const data = parsed.success ? parsed.data : null;
  const target: ReviewTarget | null = data?.prNumber
    ? { kind: "pr", prNumber: data.prNumber }
    : data?.baseRef && data.headRef
      ? { kind: "refs", baseRef: data.baseRef, headRef: data.headRef }
      : null;
  if (!target) return NextResponse.json({ error: "Pass prNumber, or baseRef and headRef." }, { status: 400 });
  if (!(await getRepoById(repoId))) return NextResponse.json({ error: "Repo not found." }, { status: 404 });
  try {
    await enqueuePreviewWarm(repoId, target);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`POST /api/repos/${repoId}/preview/warm failed:`, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to queue the warm-up." }, { status: 500 });
  }
}
