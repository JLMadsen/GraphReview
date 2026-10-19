"use client";

// Settings → Git servers (DESIGN.md §6.30): one token per server, for any
// mix of github.com, GitHub Enterprise, GitLab and other git servers. The
// user gives a server and a token; what the server is gets worked out on
// save (lib/jobs/git-server-probe.ts) and shown on its row. Tokens never
// come back to the browser — a row shows the server, its kind and the
// account, never the secret.

import { useActionState, useEffect, useState } from "react";
import { Check, ChevronRight, GitBranch, Github, Gitlab, KeyRound, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { deleteGitServerTokenAction, saveGitServerTokenAction } from "./actions";
import { SectionTitle } from "./settings-form";
import { initialSaveGitServerTokenState, type GitServerTokenSummary } from "./state";

const KIND_ICON = { github: Github, gitlab: Gitlab, git: GitBranch } as const;

function kindLine(server: GitServerTokenSummary): string {
  const who = server.username ? ` · ${server.username}` : "";
  if (server.kind === "github") return `GitHub${who}`;
  if (server.kind === "gitlab") return `GitLab${who}`;
  return `Git server — HTTPS clones only${who}`;
}

function hostLabel(origin: string): string {
  return origin.replace(/^https:\/\//, "");
}

function ServerRow({ server }: { server: GitServerTokenSummary }) {
  const Icon = KIND_ICON[server.kind];
  const [state, action, removing] = useActionState(deleteGitServerTokenAction.bind(null, server.id), { status: "idle" as const });
  return (
    <li className="flex items-center gap-2.5 py-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[13px]" title={server.origin}>
          {hostLabel(server.origin)}
        </p>
        <p className="truncate text-xs text-muted-foreground">{kindLine(server)}</p>
        {state.status === "error" && <p className="text-xs text-destructive">{state.error}</p>}
      </div>
      <form action={action}>
        <Button type="submit" size="icon-sm" variant="ghost" disabled={removing} aria-label={`Remove the token for ${hostLabel(server.origin)}`} title="Remove token">
          {removing ? <LoaderCircle className="animate-spin" /> : <X />}
        </Button>
      </form>
    </li>
  );
}

function ScopeLine({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <p>
      <span className="font-medium text-foreground/85">{name}:</span> {children}
    </p>
  );
}

function Scope({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-secondary px-1 py-px font-mono text-[11px] text-foreground/85">{children}</code>;
}

export function GitServersCard({ servers }: { servers: GitServerTokenSummary[] }) {
  const [state, action, saving] = useActionState(saveGitServerTokenAction, initialSaveGitServerTokenState);
  // Controlled, so React 19's post-action form reset can't blank a failed attempt (see settings-form.tsx).
  const [server, setServer] = useState(servers.length === 0 ? "https://github.com" : "");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");

  useEffect(() => {
    if (state.status !== "success") return;
    setServer("");
    setToken("");
    setUsername("");
  }, [state]);

  return (
    <div id="git-hosts" className="min-w-0 scroll-mt-16">
      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <SectionTitle icon={KeyRound}>Git servers</SectionTitle>
          <CardDescription className="text-[13px] leading-relaxed">
            A token per server, for private repos, and pull requests and CI on GitHub and GitLab. Repos added by SSH URL
            clone with your SSH key and don&apos;t need one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {servers.length > 0 && (
            <ul className="divide-y divide-border/60 border-y border-border">
              {servers.map((s) => (
                <ServerRow key={s.id} server={s} />
              ))}
            </ul>
          )}

          <form action={action} className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                name="server"
                aria-label="Server"
                placeholder="https://git.example.com"
                autoComplete="off"
                className="font-mono"
                value={server}
                onChange={(e) => setServer(e.target.value)}
              />
              <Input
                name="token"
                aria-label="Token"
                type="password"
                placeholder="Token"
                autoComplete="off"
                className="font-mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Input
                name="username"
                aria-label="Username (optional)"
                placeholder="Username — only if the server asks for one"
                autoComplete="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <Button type="submit" size="sm" disabled={saving || !server.trim() || !token.trim()}>
                {saving ? <LoaderCircle className="animate-spin" aria-label="Checking" /> : "Add"}
              </Button>
            </div>
            {state.status === "success" && state.saved && (
              <p className="flex items-center gap-1.5 text-[13px] text-success">
                <Check className="size-4 shrink-0" aria-hidden />
                Saved {hostLabel(state.saved.origin)} — {kindLine(state.saved)}
              </p>
            )}
            {state.status === "error" && (
              <p className="flex items-center gap-1.5 text-[13px] text-destructive">
                <TriangleAlert className="size-4 shrink-0" aria-hidden />
                {state.error}
              </p>
            )}
          </form>

          <details className="group/scopes text-xs text-muted-foreground">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open/scopes:rotate-90" aria-hidden />
              Which scopes?
            </summary>
            <div className="mt-1.5 space-y-1.5 border-l border-border pl-3 leading-relaxed">
              <ScopeLine name="GitHub, classic token">
                <Scope>repo</Scope>, or <Scope>public_repo</Scope> if every repo you review is public.
              </ScopeLine>
              <ScopeLine name="GitHub, fine-grained token">
                on the repos you review: <Scope>Contents</Scope>, <Scope>Metadata</Scope>, <Scope>Issues</Scope>,{" "}
                <Scope>Checks</Scope>, <Scope>Commit statuses</Scope> and <Scope>Actions</Scope> read;{" "}
                <Scope>Pull requests</Scope> read and write (write only to post reviews).
              </ScopeLine>
              <ScopeLine name="GitLab">
                <Scope>api</Scope> (with at least Reporter access), or <Scope>read_api</Scope> and{" "}
                <Scope>read_repository</Scope> for everything except posting reviews.
              </ScopeLine>
              <ScopeLine name="Other git servers">read access to the repositories; it is only used to clone.</ScopeLine>
            </div>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}
