"use client";

// "Connect a coding agent" — how to point each popular agent harness at
// GraphReview's MCP server (lib/mcp/). Purely instructional: nothing here is
// saved. `url` comes from the server (the host this page was served on), so
// the snippets carry the port this instance actually runs on.

import { useState } from "react";
import { Cable, Check, ClipboardCopy } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "cn";
import { SectionTitle } from "./settings-form";

interface Harness {
  id: string;
  name: string;
  /** Where the snippet goes: "Run" for a command, else the config file. */
  where: string;
  snippet: (url: string) => string;
  note?: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

const HARNESSES: Harness[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    // A file, not `claude mcp add`: the desktop app doesn't put the `claude`
    // command on the PATH, and both the app and the CLI read `.mcp.json`.
    where: ".mcp.json in the root of the repo the agent works in",
    snippet: (url) => json({ mcpServers: { graphreview: { type: "http", url } } }),
    note: "Works in the Claude desktop app and the CLI; start a new session and approve the server when asked. With the CLI installed, `claude mcp add --transport http --scope user graphreview <url>` adds it for every project instead.",
  },
  {
    id: "codex",
    name: "Codex",
    where: "Run",
    snippet: (url) => `codex mcp add graphreview --url ${url}`,
    note: "Or add [mcp_servers.graphreview] with url = \"…\" to ~/.codex/config.toml.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    where: "opencode.json (project) or ~/.config/opencode/opencode.json",
    snippet: (url) =>
      json({
        $schema: "https://opencode.ai/config.json",
        mcp: { graphreview: { type: "remote", url, enabled: true } },
      }),
  },
  {
    id: "copilot-vscode",
    name: "Copilot (VS Code)",
    where: ".vscode/mcp.json",
    snippet: (url) => json({ servers: { graphreview: { type: "http", url } } }),
    note: "For every workspace, use “MCP: Open User Configuration” instead. Start the server from the file's inline “Start” action, then use Agent mode.",
  },
  {
    id: "copilot-cli",
    name: "Copilot CLI",
    where: "Run",
    snippet: (url) => `copilot mcp add --transport http graphreview ${url}`,
    note: "Writes to ~/.copilot/mcp-config.json.",
  },
  {
    id: "cursor",
    name: "Cursor",
    where: "~/.cursor/mcp.json (or .cursor/mcp.json in the project)",
    snippet: (url) => json({ mcpServers: { graphreview: { url } } }),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    where: "Run",
    snippet: (url) => `gemini mcp add --transport http graphreview ${url}`,
    note: "Or add { \"httpUrl\": \"…\" } under mcpServers in ~/.gemini/settings.json.",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    where: "~/.codeium/windsurf/mcp_config.json",
    snippet: (url) => json({ mcpServers: { graphreview: { serverUrl: url } } }),
  },
];

/** `wrap` for prose; commands and config keep their lines and scroll instead. */
function CopyBlock({ text, wrap = false }: { text: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/copy relative">
      <pre
        className={cn(
          "overflow-x-auto rounded-lg border border-border bg-secondary/40 p-3 pr-10 font-mono text-xs leading-relaxed",
          wrap && "whitespace-pre-wrap"
        )}
      >
        {text}
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

export function McpCard({ url }: { url: string }) {
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <SectionTitle icon={Cable}>Connect a coding agent</SectionTitle>
        <CardDescription className="text-[13px] leading-relaxed">
          GraphReview runs an MCP server at <code className="font-mono text-foreground">{url}</code> while it is
          open. A connected agent can read a review&apos;s open findings and the diff of each flagged component, and
          answer each finding — explain why it doesn&apos;t hold (resolves it) or agree and fix it. Replies show under
          the finding. Only reachable from this machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs defaultValue={HARNESSES[0].id}>
          <TabsList variant="line" className="w-full flex-wrap justify-start gap-y-2 group-data-horizontal/tabs:h-auto">
            {HARNESSES.map((harness) => (
              <TabsTrigger key={harness.id} value={harness.id} className="flex-none px-2 text-[13px]">
                {harness.name}
              </TabsTrigger>
            ))}
          </TabsList>
          {HARNESSES.map((harness) => (
            <TabsContent key={harness.id} value={harness.id} className="space-y-2 pt-3">
              <p className="text-[13px] text-muted-foreground">
                {harness.where === "Run" ? "Run in a terminal:" : <>Add to <span className="font-mono">{harness.where}</span>:</>}
              </p>
              <CopyBlock text={harness.snippet(url)} />
              {harness.note && <p className="text-xs text-muted-foreground">{harness.note}</p>}
            </TabsContent>
          ))}
        </Tabs>
        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-[13px] text-muted-foreground">
            Then, from the repo&apos;s folder, run the server&apos;s <span className="font-mono">review</span> prompt — in
            Claude Code <span className="font-mono text-foreground">/mcp__graphreview__review</span>, in VS Code{" "}
            <span className="font-mono text-foreground">/mcp.graphreview.review</span>. It finds the review for your branch
            and works through it. Where your agent has no MCP prompts, paste this instead:
          </p>
          <CopyBlock
            wrap
            text="Read the GraphReview review of this branch. For each open finding, check the code: if it's wrong, answer it with why; if it's right, fix it and reply that you're fixing it." />
        </div>
      </CardContent>
    </Card>
  );
}
