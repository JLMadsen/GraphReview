// The MCP endpoint coding agents connect to (lib/mcp/server.ts).
//
//   POST /api/mcp   MCP Streamable HTTP, stateless, JSON responses
//
// Stateless: each POST gets a fresh server + transport, since every tool
// reads straight from the database. That also means there is no server-sent
// event stream to open, so GET (and DELETE, which ends a session) answer 405,
// as the spec allows. middleware.ts keeps this to loopback callers.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createGraphReviewMcpServer } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
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
