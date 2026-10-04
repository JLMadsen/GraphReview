// Live "a finding changed" notifications for one review target.
//
//   GET /api/repos/[repoId]/review/events?prNumber=N | ?baseRef=X&headRef=Y
//
// A server-sent event stream: one `findings` event (data: the finding id)
// each time a finding of that target changes outside the review job — a
// coding agent replying over MCP (lib/mcp/events.ts). The review dock
// refetches the review on each one. Carries no finding data itself, so the
// review GET stays the one source of truth.

import { reviewTargetKey } from "@/lib/jobs";
import { onFindingsChanged } from "@/lib/mcp/events";
import { apiError, targetFromSearchParams } from "../../../_shared";

export const dynamic = "force-dynamic";

/** Comment line sent while idle, so proxies and the browser keep the connection open. */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const target = targetFromSearchParams(new URL(request.url).searchParams);
  if (!target) return apiError("Query must be ?prNumber=N or ?baseRef=X&headRef=Y.", 400);
  const targetKey = reviewTargetKey(target);

  const encoder = new TextEncoder();
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close(); // the client went away between the event and this write
        }
      };
      const unsubscribe = onFindingsChanged(repoId, targetKey, (findingId) => {
        send(`event: findings\ndata: ${findingId}\n\n`);
      });
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", () => close());
      send(": connected\n\n");
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform: keeps compression from buffering the stream.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
