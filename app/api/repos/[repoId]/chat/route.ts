// The PR chat (DESIGN.md §6.7), one thread per review target.
//
//   GET    /api/repos/[repoId]/chat?prNumber=12 | ?baseRef=&headRef=   the thread
//   POST   /api/repos/[repoId]/chat  {target, message, focusComponentId?}
//          streams NDJSON: {type:"user"} → {type:"step"}* → {type:"answer"} (or {type:"error"})
//   DELETE /api/repos/[repoId]/chat?…target                            clears the thread
//
// POST streams so the chat column can show each lookup ("read
// app/map/page.tsx") while the model is still working — a local model
// can take a minute over a question that needs several of them.

import { NextResponse } from "next/server";
import { z } from "zod";
import { reviewTargetKey } from "@/lib/jobs";
import { loadAiConfigOrNull } from "@/lib/jobs/merge-naming";
import { loadPrContext } from "@/lib/jobs/pr-context";
import { runChatTurn } from "@/lib/jobs/pr-chat";
import { clearChatMessages, listChatMessages } from "@/lib/neo4j";
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;
  const target = targetFromSearchParams(new URL(request.url).searchParams);
  if (!target) return apiError("Expected ?prNumber= or ?baseRef=&headRef=.", 400);

  try {
    const [messages, config, headSha] = await Promise.all([
      listChatMessages(repoId, reviewTargetKey(target)),
      loadAiConfigOrNull(),
      // Best-effort: without the current head the thread still loads, it just can't say what's stale.
      loadPrContext(loaded.repo, target)
        .then((ctx) => ctx.reviewed.headSha)
        .catch(() => undefined),
    ]);
    const body: ChatThreadDTO = { messages, headSha, aiConfigured: config !== null };
    return NextResponse.json(body);
  } catch (error) {
    return apiError(`Could not load the chat: ${errorMessage(error)}`, 503);
  }
}

const postSchema = z.object({
  target: targetBodySchema,
  message: z.string().trim().min(1).max(4000),
  focusComponentId: z.string().min(1).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<Response> {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("Expected {target, message, focusComponentId?}.", 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEventDTO) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        await runChatTurn({
          repo: loaded.repo,
          target: toReviewTarget(parsed.data.target),
          question: parsed.data.message,
          focusComponentId: parsed.data.focusComponentId,
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

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;
  const target = targetFromSearchParams(new URL(request.url).searchParams);
  if (!target) return apiError("Expected ?prNumber= or ?baseRef=&headRef=.", 400);
  try {
    const deleted = await clearChatMessages(repoId, reviewTargetKey(target));
    return NextResponse.json({ deleted });
  } catch (error) {
    return apiError(`Could not clear the chat: ${errorMessage(error)}`, 503);
  }
}
