// One checklist item definition (DESIGN.md §6.6).
//
//   PATCH  /api/checklist/items/[itemId]  {label?, question?, limit?, patterns?, enabled?}
//   DELETE /api/checklist/items/[itemId]  removes it (and its stored AI answers)

import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteChecklistItem, updateChecklistItem } from "@/lib/neo4j";
import { apiError, errorMessage } from "@/app/api/repos/_shared";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  question: z.string().trim().max(1000).optional(),
  limit: z.number().int().positive().max(1_000_000).optional(),
  patterns: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  const { itemId } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("Invalid update.", 400, parsed.error.issues);
  try {
    const item = await updateChecklistItem(itemId, parsed.data);
    return item ? NextResponse.json(item) : apiError("No such checklist item.", 404);
  } catch (error) {
    return apiError(`Could not update the item: ${errorMessage(error)}`, 503);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  const { itemId } = await params;
  try {
    await deleteChecklistItem(itemId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(`Could not delete the item: ${errorMessage(error)}`, 503);
  }
}
