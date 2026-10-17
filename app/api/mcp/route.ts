// The MCP endpoint coding agents connect to (lib/mcp/server.ts).
//
//   POST /api/mcp   MCP Streamable HTTP, stateless, JSON responses
//
// Stateless: each POST gets a fresh server + transport, since every tool
// reads straight from the database. That also means there is no server-sent
// event stream to open, so GET (and DELETE, which ends a session) answer 405,
// as the spec allows. middleware.ts keeps this to loopback callers; with a
// bearer token turned on in Settings (lib/mcp/token.ts, DESIGN.md §6.26 §3)
// a request must also carry it.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createGraphReviewMcpServer } from "@/lib/mcp/server";
import { getMcpToken, mcpRequestAllowed } from "@/lib/mcp/token";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!mcpRequestAllowed(request.headers.get("authorization"), await getMcpToken())) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized — this GraphReview requires its MCP token (Settings → Connect a coding agent)." }, id: null },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="graphreview"' } }
    );
  }
  const server = createGraphReviewMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

function methodNotAllowed(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed — this server is stateless; POST only." }, id: null },
    { status: 405, headers: { Allow: "POST" } }
  );
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
