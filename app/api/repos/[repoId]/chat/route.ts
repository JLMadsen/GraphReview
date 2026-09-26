// The chat (DESIGN.md §6.7), one thread per review target plus one
// repo-wide thread for when no diff is selected.
//
//   GET    /api/repos/[repoId]/chat?prNumber=12 | ?baseRef=&headRef= | ?scope=repo   the thread
//   POST   /api/repos/[repoId]/chat  {target, message, focusComponentId?}
//                                  | {scope:"repo", message, focusComponentId?}
//          streams NDJSON: {type:"user"} → {type:"step"}* → {type:"answer"} (or {type:"error"})
//   DELETE /api/repos/[repoId]/chat?…target | ?scope=repo                           clears the thread
//
// POST streams so the chat column can show each lookup ("read
// app/map/page.tsx") while the model is still working — a local model
// can take a minute over a question that needs several of them.

import { NextResponse } from "next/server";
import { z } from "zod";
import { reviewTargetKey, type ReviewTarget } from "@/lib/jobs";
import { loadAiConfigOrNull } from "@/lib/jobs/merge-naming";
import { loadPrContext } from "@/lib/jobs/pr-context";
import { REPO_CHAT_THREAD_KEY, runChatTurn } from "@/lib/jobs/pr-chat";
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
  const target = threadFromSearchParams(new URL(request.url).searchParams);
  if (target === undefined) return apiError(TARGET_EXPECTED, 400);
  try {
    const deleted = await clearChatMessages(repoId, target ? reviewTargetKey(target) : REPO_CHAT_THREAD_KEY);
    return NextResponse.json({ deleted });
  } catch (error) {
    return apiError(`Could not clear the chat: ${errorMessage(error)}`, 503);
  }
}
