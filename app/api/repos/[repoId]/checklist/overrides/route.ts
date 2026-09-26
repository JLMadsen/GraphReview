// POST /api/repos/[repoId]/checklist/overrides  {itemId, disabled}
//
// Switches one *global* checklist item off (or back on) for this repo only
// (DESIGN.md §6.6). The repo's own items are edited through
// /api/checklist/items instead.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getChecklistItem, setChecklistItemDisabledForRepo } from "@/lib/neo4j";
import { apiError, errorMessage, loadRepo } from "@/app/api/repos/_shared";

export const dynamic = "force-dynamic";

const schema = z.object({ itemId: z.string().min(1), disabled: z.boolean() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("Expected {itemId, disabled}.", 400);

  try {
    const item = await getChecklistItem(parsed.data.itemId);
    if (!item) return apiError("No such checklist item.", 404);
    if (item.scope !== "global") return apiError("Only global items can be switched off per repo.", 400);
    await setChecklistItemDisabledForRepo(repoId, item.id, parsed.data.disabled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(`Could not update the checklist: ${errorMessage(error)}`, 503);
  }
}
