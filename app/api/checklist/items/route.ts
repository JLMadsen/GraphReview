// Checklist item definitions (DESIGN.md §6.6).
//
//   GET  /api/checklist/items[?repoId=]  global items (+ the repo's own, with its overrides)
//   POST /api/checklist/items            create one: {scope: "global" | <repoId>, kind, label, question?, limit?, patterns?}

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CHECKLIST_ITEM_KINDS,
  createChecklistItem,
  getDisabledChecklistItemIds,
  getRepoById,
  listChecklistItems,
} from "@/lib/neo4j";
import type { ChecklistItemKind } from "@/lib/neo4j";
import { apiError, errorMessage } from "@/app/api/repos/_shared";
import type { ChecklistItemsResponseDTO } from "@/components/graph/checklist-types";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const repoId = new URL(request.url).searchParams.get("repoId") ?? undefined;
  try {
    const [items, disabled] = await Promise.all([
      listChecklistItems(repoId),
      repoId ? getDisabledChecklistItemIds(repoId) : Promise.resolve([] as string[]),
    ]);
    const off = new Set(disabled);
    const body: ChecklistItemsResponseDTO = {
      items: items.map((item) => ({
        ...item,
        disabledForRepo: repoId && item.scope === "global" ? off.has(item.id) : undefined,
      })),
    };
    return NextResponse.json(body);
  } catch (error) {
    return apiError(`Could not load the checklist: ${errorMessage(error)}`, 503);
  }
}

const itemFieldsSchema = z.object({
  label: z.string().trim().min(1).max(120),
  question: z.string().trim().max(1000).optional(),
  limit: z.number().int().positive().max(1_000_000).optional(),
  patterns: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
});

const createSchema = itemFieldsSchema.extend({
  scope: z.string().min(1),
  kind: z.enum(CHECKLIST_ITEM_KINDS as [ChecklistItemKind, ...ChecklistItemKind[]]),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("Invalid checklist item.", 400, parsed.error.issues);
  const input = parsed.data;
  if (input.kind === "ai" && !input.question) return apiError("An AI item needs a question.", 400);

  try {
    if (input.scope !== "global" && !(await getRepoById(input.scope))) return apiError("No such repo.", 404);
    const item = await createChecklistItem(input);
    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    return apiError(`Could not create the item: ${errorMessage(error)}`, 503);
  }
}
