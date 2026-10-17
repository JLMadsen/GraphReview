"use client";

// "Connect a coding agent" — how to point each popular agent harness at
// GraphReview's MCP server (lib/mcp/). Purely instructional: nothing here is
// saved, except the optional bearer token (DESIGN.md §6.26 §3), which the
// snippets then include. `url` comes from the server (the host this page was served on), so
// the snippets carry the port this instance actually runs on.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Cable, Check, ChevronRight, ClipboardCopy, KeyRound } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "cn";
import { clearMcpTokenAction, createMcpTokenAction } from "./actions";
import { SectionTitle } from "./settings-form";

const where = (h: Harness, token: string | null) => (typeof h.where === "function" ? h.where(token) : h.where);

interface Harness {
  id: string;
  name: string;
  /** Where the snippet goes: "Run" for a command, else the config file. */
  where: string | ((token: string | null) => string);
  /** `token` is the MCP bearer token when one is required (DESIGN.md §6.26 §3). */
  snippet: (url: string, token: string | null) => string;
  note?: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);
const auth = (token: string | null) => (token ? { headers: { Authorization: `Bearer ${token}` } } : {});
const headerFlag = (token: string | null) => (token ? ` --header "Authorization: Bearer ${token}"` : "");

const HARNESSES: Harness[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    // A file, not `claude mcp add`: the desktop app doesn't put the `claude`
    // command on the PATH, and both the app and the CLI read `.mcp.json`.
    where: ".mcp.json in the root of the repo the agent works in",
    snippet: (url, token) => json({ mcpServers: { graphreview: { type: "http", url, ...auth(token) } } }),
    note: "Works in the Claude desktop app and the CLI; start a new session and approve the server when asked. With the CLI installed, `claude mcp add --transport http --scope user graphreview <url>` (plus `--header \"Authorization: Bearer <token>\"` when a token is required) adds it for every project instead.",
  },
  {
    id: "codex",
    name: "Codex",
    where: (token) => (token ? "~/.codex/config.toml" : "Run"),
    snippet: (url, token) =>
      token
        ? `[mcp_servers.graphreview]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }`
        : `codex mcp add graphreview --url ${url}`,
    note: 'Or add [mcp_servers.graphreview] with url = "…" to ~/.codex/config.toml.',
  },
  {
    id: "opencode",
    name: "OpenCode",
    where: "opencode.json (project) or ~/.config/opencode/opencode.json",
    snippet: (url, token) =>
      json({
        $schema: "https://opencode.ai/config.json",
        mcp: { graphreview: { type: "remote", url, enabled: true, ...auth(token) } },
      }),
  },
  {
    id: "copilot-vscode",
    name: "Copilot (VS Code)",
    where: ".vscode/mcp.json",
    snippet: (url, token) => json({ servers: { graphreview: { type: "http", url, ...auth(token) } } }),
    note: "For every workspace, use “MCP: Open User Configuration” instead. Start the server from the file's inline “Start” action, then use Agent mode.",
  },
  {
    id: "copilot-cli",
    name: "Copilot CLI",
    where: (token) => (token ? "~/.copilot/mcp-config.json" : "Run"),
    snippet: (url, token) =>
      token
        ? json({ mcpServers: { graphreview: { type: "http", url, ...auth(token), tools: ["*"] } } })
        : `copilot mcp add --transport http graphreview ${url}`,
    note: "Writes to ~/.copilot/mcp-config.json.",
  },
  {
    id: "cursor",
    name: "Cursor",
    where: "~/.cursor/mcp.json (or .cursor/mcp.json in the project)",
    snippet: (url, token) => json({ mcpServers: { graphreview: { url, ...auth(token) } } }),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    where: "Run",
    snippet: (url, token) => `gemini mcp add --transport http graphreview ${url}${headerFlag(token)}`,
    note: 'Or add { "httpUrl": "…" } under mcpServers in ~/.gemini/settings.json.',
  },
  {
    id: "windsurf",
    name: "Windsurf",
    where: "~/.codeium/windsurf/mcp_config.json",
    snippet: (url, token) => json({ mcpServers: { graphreview: { serverUrl: url, ...auth(token) } } }),
  },
];

/** `wrap` for prose; commands and config keep their lines and scroll instead. */
function CopyBlock({ text, display, wrap = false }: { text: string; display?: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/copy relative">
      <pre
        className={cn(
          "overflow-x-auto rounded-lg border border-border bg-secondary/40 p-3 pr-10 font-mono text-xs leading-relaxed",
          wrap && "whitespace-pre-wrap"
        )}
      >
        {display ?? text}
      </pre>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked — the text is selectable */
          }
        }}
        className="absolute top-2 right-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        title={copied ? "Copied" : "Copy"}
        aria-label={copied ? "Copied" : "Copy"}
      >
        {copied ? <Check className="size-3.5 text-success" /> : <ClipboardCopy className="size-3.5" />}
      </button>
    </div>
  );
}

/**
 * The optional bearer token: off by default (the endpoint is loopback-only);
 * on, every agent must send it, and the snippets above carry it.
 */
function TokenControl({ token }: { token: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<{ status: string; error?: string }>) =>
    startTransition(async () => {
      const result = await action();
      setError(result.status === "error" ? result.error ?? "Failed." : null);
      router.refresh();
    });
  const button = "rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary disabled:opacity-50";
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-[13px] font-medium">Bearer token</span>
        <span className="text-xs text-muted-foreground">{token ? "required" : "off"}</span>
        <span className="ml-auto flex gap-1.5">
          {token ? (
            <>
              <button type="button" className={button} disabled={pending} onClick={() => setShown((s) => !s)}>
                {shown ? "Hide" : "Show"}
              </button>
              <button type="button" className={button} disabled={pending} onClick={() => run(createMcpTokenAction)} title="Agents set up with the old token stop working">
                New token
              </button>
              <button type="button" className={button} disabled={pending} onClick={() => run(clearMcpTokenAction)}>
                Turn off
              </button>
            </>
          ) : (
            <button type="button" className={button} disabled={pending} onClick={() => run(createMcpTokenAction)}>
              Require a token
            </button>
          )}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {token
          ? "Agents must send it as “Authorization: Bearer …”; the setup steps below include it."
          : "Off: any program on this machine can use the MCP server. Turn it on if other users or processes here shouldn't read your reviews."}
      </p>
      {token && <CopyBlock text={token} display={shown ? token : `${token.slice(0, 6)}${"•".repeat(24)}`} />}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function McpCard({ url, token }: { url: string; token: string | null }) {
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <SectionTitle icon={Cable}>Connect a coding agent</SectionTitle>
        <CardDescription className="text-[13px] leading-relaxed">
          An agent connected to this MCP server can read a review&apos;s open findings and answer or fix each one. Only
          reachable from this machine, while GraphReview is open.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <CopyBlock text={url} />
        <TokenControl token={token} />
        {/* The per-agent steps are long and needed once, so they start folded. */}
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
            Setup steps for your agent
          </summary>
          <div className="mt-3 space-y-4">
            <Tabs defaultValue={HARNESSES[0].id}>
              <TabsList
                variant="line"
                className="w-full flex-wrap justify-start gap-y-2 group-data-horizontal/tabs:h-auto"
              >
                {HARNESSES.map((harness) => (
                  <TabsTrigger key={harness.id} value={harness.id} className="flex-none px-2 text-[13px]">
                    {harness.name}
                  </TabsTrigger>
                ))}
              </TabsList>
              {HARNESSES.map((harness) => (
                <TabsContent key={harness.id} value={harness.id} className="space-y-2 pt-3">
                  <p className="text-[13px] text-muted-foreground">
                    {where(harness, token) === "Run" ? (
                      "Run in a terminal:"
                    ) : (
                      <>
                        Add to <span className="font-mono">{where(harness, token)}</span>:
                      </>
                    )}
                  </p>
                  <CopyBlock
                    text={harness.snippet(url, token)}
                    display={token ? harness.snippet(url, token).replaceAll(token, `${token.slice(0, 6)}…`) : undefined}
                  />
                  {harness.note && <p className="text-xs text-muted-foreground">{harness.note}</p>}
                </TabsContent>
              ))}
            </Tabs>
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-[13px] text-muted-foreground">
                Then, from the repo&apos;s folder, run the server&apos;s <span className="font-mono">review</span>{" "}
                prompt — in Claude Code <span className="font-mono text-foreground">/mcp__graphreview__review</span>, in
                VS Code <span className="font-mono text-foreground">/mcp.graphreview.review</span>. It finds the review
                for your branch and works through it. Where your agent has no MCP prompts, paste this instead:
              </p>
              <CopyBlock
                wrap
                text="Read the GraphReview review of this branch. For each open finding, check the code: if it's wrong, answer it with why; if it's right, fix it and reply that you're fixing it."
              />
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
