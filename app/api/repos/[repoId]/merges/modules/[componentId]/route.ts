// POST /api/repos/[repoId]/merges/modules/[componentId]
//   {action: "unmerge"}                     delete the merged module and regroup
//   {action: "rename", name, description?}  set its name (and description)
//   {action: "name-with-ai"}                one model call to name/describe it
//
// `name-with-ai` is what the Graph tab calls right after an accept. It
// answers `{named: false}` (not an error) when no AI provider is configured
// or the reply was unusable — the heuristic name simply stays.

import { NextResponse } from "next/server";
import { z } from "zod";
import { MergeActionError, renameMergedModule, unmergeModule } from "@/lib/jobs/merges";
import { nameMergedModuleWithAi } from "@/lib/jobs/merge-naming";
import { apiError, errorMessage, loadRepo } from "@/app/api/repos/_shared";
import type { NameWithAiResponseDTO } from "@/components/graph/merge-types";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("unmerge") }),
  z.object({
    action: z.literal("rename"),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
  }),
  z.object({ action: z.literal("name-with-ai") }),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string; componentId: string }> }
): Promise<NextResponse> {
  const { repoId, componentId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("Invalid action.", 400, parsed.error.issues);

  const log = (message: string) => console.log(`[merges] ${repoId} · ${message}`);
  try {
    switch (parsed.data.action) {
      case "unmerge":
        await unmergeModule(repoId, componentId, log);
        return NextResponse.json({ ok: true });
      case "rename": {
        const updated = await renameMergedModule(
          repoId,
          componentId,
          parsed.data.name,
          parsed.data.description
        );
        return NextResponse.json({ id: updated.id, name: updated.name, description: updated.description });
      }
      case "name-with-ai": {
        const result = await nameMergedModuleWithAi(repoId, componentId, log);
        const body: NameWithAiResponseDTO = {
          named: result.named,
          name: result.component.name,
          description: result.component.description,
        };
        return NextResponse.json(body);
      }
    }
  } catch (error) {
    if (error instanceof MergeActionError) return apiError(error.message, error.status);
    return apiError(`Could not update the module: ${errorMessage(error)}`, 500);
  }
}
