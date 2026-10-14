// The chat (DESIGN.md §6.7), one thread per review target plus one
// repo-wide thread for when no diff is selected.
//
//   GET    /api/repos/[repoId]/chat?prNumber=12 | ?baseRef=&headRef= | ?scope=repo   the thread
//   POST   /api/repos/[repoId]/chat  {target, message, focusComponentId?, findingId?, screen?}
//                                  | {scope:"repo", message, focusComponentId?, screen?}
//          streams NDJSON: {type:"user"} → {type:"step"}* → {type:"answer"} (or {type:"error"})
//   PATCH  /api/repos/[repoId]/chat  {messageId, suggestionId, action:"add"|"dismiss"}
//                                  | {messageId, triageId, action:"apply"|"dismiss"}
//          the reviewer's answer to a finding the chat suggested, or to its verdict on
//          an existing finding; returns the updated message
//   DELETE /api/repos/[repoId]/chat?…target | ?scope=repo                           clears the thread
//
// POST streams so the chat column can show each lookup ("read
// app/map/page.tsx") while the model is still working — a local model
// can take a minute over a question that needs several of them.

import { NextResponse } from "next/server";
import { z } from "zod";
import { reviewTargetKey, type ReviewTarget } from "@/lib/jobs";
import { loadAiConfigOrNull } from "@/lib/jobs/ai-config";
import { loadPrContext } from "@/lib/jobs/pr-context";
import { REPO_CHAT_THREAD_KEY, addSuggestedFinding, applyChatTriage, runChatTurn } from "@/lib/jobs/pr-chat";
import { clearChatMessages, getChatMessage, listChatMessages, updateChatSuggestion, updateChatTriage } from "@/lib/db";
import {
  apiError,
  errorMessage,
  loadRepo,
  targetBodySchema,
  targetFromSearchParams,
  toReviewTarget,
} from "@/app/api/repos/_shared";
import type { ChatStreamEventDTO, ChatThreadDTO } from "@/components/graph/chat-types";

export const dynamic = "force-dynamic";

const TARGET_EXPECTED = "Expected ?prNumber=, ?baseRef=&headRef= or ?scope=repo.";

/** The thread a query names: a review target, the repo-wide thread (`null`), or nothing usable (`undefined`). */
function threadFromSearchParams(params: URLSearchParams): ReviewTarget | null | undefined {
  if (params.get("scope") === "repo") return null;
  return targetFromSearchParams(params) ?? undefined;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;
  const target = threadFromSearchParams(new URL(request.url).searchParams);
  if (target === undefined) return apiError(TARGET_EXPECTED, 400);

  try {
    const [messages, config, headSha] = await Promise.all([
      listChatMessages(repoId, target ? reviewTargetKey(target) : REPO_CHAT_THREAD_KEY),
      loadAiConfigOrNull(),
      // Best-effort: without the current head the thread still loads, it just can't say what's stale.
      target
        ? loadPrContext(loaded.repo, target)
            .then((ctx) => ctx.reviewed.headSha)
            .catch(() => undefined)
        : Promise.resolve(loaded.repo.lastAnalyzedSha),
    ]);
    const body: ChatThreadDTO = { messages, headSha, aiConfigured: config !== null };
    return NextResponse.json(body);
  } catch (error) {
    return apiError(`Could not load the chat: ${errorMessage(error)}`, 503);
  }
}

const turnFields = {
  message: z.string().trim().min(1).max(4000),
  focusComponentId: z.string().min(1).optional(),
  findingId: z.string().min(1).optional(),
  screen: z.string().max(2000).optional(),
};
const postSchema = z.union([
  z.object({ target: targetBodySchema, ...turnFields }),
  z.object({ scope: z.literal("repo"), ...turnFields }),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<Response> {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("Expected {target | scope: \"repo\", message, focusComponentId?}.", 400);
  const body = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEventDTO) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        await runChatTurn({
          repo: loaded.repo,
          target: "target" in body ? toReviewTarget(body.target) : null,
          question: body.message,
          focusComponentId: body.focusComponentId,
          findingId: body.findingId,
          screen: body.screen,
          onEvent: (event) => send(event),
          signal: request.signal,
          log: (message) => console.log(`[chat] ${repoId} · ${message}`),
        });
      } catch (error) {
        send({ type: "error", error: errorMessage(error) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

const suggestionSchema = z.union([
  z.object({ messageId: z.string().min(1), suggestionId: z.string().min(1), action: z.enum(["add", "dismiss"]) }),
  z.object({ messageId: z.string().min(1), triageId: z.string().min(1), action: z.enum(["apply", "dismiss"]) }),
]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;
  const parsed = suggestionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError('Expected {messageId, suggestionId, action: "add" | "dismiss"} or {messageId, triageId, action: "apply" | "dismiss"}.', 400);
  }
  if ("triageId" in parsed.data) {
    const { messageId, triageId, action } = parsed.data;
    try {
      const message = await getChatMessage(repoId, messageId);
      if (!message?.triage?.some((x) => x.id === triageId)) return apiError("That verdict is gone.", 404);
      const updated = action === "apply" ? await applyChatTriage(message, triageId) : await updateChatTriage(repoId, messageId, triageId, "dismissed");
      if (!updated) return apiError(action === "apply" ? "That finding is gone — a re-review replaced it." : "That verdict is gone.", 404);
      return NextResponse.json({ message: updated });
    } catch (error) {
      return apiError(`Could not ${action} the verdict: ${errorMessage(error)}`, 503);
    }
  }
  const { messageId, suggestionId, action } = parsed.data;
  try {
    const message = await getChatMessage(repoId, messageId);
    if (!message?.suggestions?.some((x) => x.id === suggestionId)) return apiError("That suggestion is gone.", 404);
    const updated =
      action === "add"
        ? (await addSuggestedFinding(message, suggestionId))?.message
        : await updateChatSuggestion(repoId, messageId, suggestionId, { status: "dismissed" });
    if (!updated) return apiError("That suggestion is gone.", 404);
    return NextResponse.json({ message: updated });
  } catch (error) {
    return apiError(`Could not ${action} the suggestion: ${errorMessage(error)}`, 503);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;
  const target = threadFromSearchParams(new URL(request.url).searchParams);
  if (target === undefined) return apiError(TARGET_EXPECTED, 400);
  try {
    const deleted = await clearChatMessages(repoId, target ? reviewTargetKey(target) : REPO_CHAT_THREAD_KEY);
    return NextResponse.json({ deleted });
  } catch (error) {
    return apiError(`Could not clear the chat: ${errorMessage(error)}`, 503);
  }
}
