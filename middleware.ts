// Request guard for a server that has no login.
//
// GraphReview listens on 127.0.0.1, but any web page the user visits can
// still make their browser send requests there:
//
// - **Cross-site requests.** A page can POST to http://127.0.0.1:3470/api/…
//   (a `text/plain` body needs no CORS preflight) — e.g. add any folder as a
//   repo and start a review that sends its files to the AI provider. Such a
//   request carries the attacker's `Origin`, so anything but GET/HEAD must
//   come from the app's own origin.
// - **DNS rebinding.** A page on attacker.example re-resolves its own name to
//   127.0.0.1 and then reads responses as same-origin. Those requests carry
//   `Host: attacker.example`, so only loopback host names are served.
//
// GRAPHREVIEW_ALLOWED_HOSTS (comma-separated host names) adds others, for
// anyone who deliberately serves it under another name.

import { NextResponse, type NextRequest } from "next/server";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(host: string): string {
  // `[::1]:3470` → `[::1]`, `127.0.0.1:3470` → `127.0.0.1`.
  return (host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]).toLowerCase();
}

function isAllowedHost(host: string | null): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  if (LOOPBACK.has(name) || name.endsWith(".localhost")) return true;
  const extra = (process.env.GRAPHREVIEW_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(name);
}

function forbidden(reason: string): NextResponse {
  return NextResponse.json({ error: reason }, { status: 403 });
}

export function middleware(request: NextRequest): NextResponse {
  const host = request.headers.get("host");
  if (!isAllowedHost(host)) {
    return forbidden("GraphReview only answers requests addressed to localhost / 127.0.0.1.");
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (origin !== null) {
      let originHost: string | undefined;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = undefined; // "null" (sandboxed frames, file://) and garbage
      }
      if (originHost !== host) return forbidden("Cross-site requests are not allowed.");
    } else if (request.headers.get("sec-fetch-site") === "cross-site") {
      return forbidden("Cross-site requests are not allowed.");
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
