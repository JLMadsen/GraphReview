// What the command palette's reviewer picked (DESIGN.md §6.18): recents for
// the empty query and a ranking boost.
//
//   POST /api/search/history  { repoId?, item: SearchItem }

import { NextResponse } from "next/server";
import { z } from "zod";
import { recordPalettePick } from "@/lib/db";
import { apiError, errorMessage } from "../../repos/_shared";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  repoId: z.string().min(1).optional(),
  item: z
    .object({ key: z.string().min(1).max(1200), kind: z.string(), id: z.string(), title: z.string() })
    .passthrough(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("Body must be { repoId?, item }.", 400);
  try {
    // Scores and match positions belong to the query that found it.
    const item: Record<string, unknown> = { ...parsed.data.item, score: 0 };
    delete item.match;
    recordPalettePick(parsed.data.repoId ?? "", parsed.data.item.key, item);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(`Could not record the pick: ${errorMessage(error)}`, 500);
  }
}
