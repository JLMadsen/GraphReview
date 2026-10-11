"use client";

// Client half of the settings screen.
//
// Secret fields (GitHub PAT, AI provider API keys) never round-trip a
// decrypted value from the server: the server only tells this component
// whether a secret is currently saved. When one is saved, it renders as a
// masked badge with a "Replace" action rather than a pre-filled password
// input — clicking "Replace" swaps in a blank input for fresh entry. Only
// on submit does a freshly-typed secret leave the browser, straight into a
// server action (never persisted client-side first).
//
// AI providers are a *list*, each independently saved/edited/deleted/tested,
// with exactly one marked active (the toggle). Every provider row owns its
// own `useActionState`s so one row's save/delete/test can't stomp another's,
// and each server action takes the provider's id as a *bound* first
// argument rather than reading it from FormData — React 19 builds a server
// action's FormData itself and does not include a submitter button's own
// name/value, so binding is what makes "which provider" unambiguous (see
// app/settings/actions.ts's comments for the full story).
//
// Every input is *controlled*, and that is load-bearing rather than taste:
// React 19 automatically resets a form's uncontrolled fields once an action
// finishes. With `defaultValue`, clicking "Test connection" emptied the base
// URL and model name the moment the ping came back — you'd verify an
// endpoint and be left with a blank form to retype before you could save it.
// Controlled state survives the reset.

import { useActionState, useEffect, useState } from "react";
import {
  Bot,
  Check,
  Github,
  Gitlab,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  clearGithubPatAction,
  clearGitlabPatAction,
  saveGithubPatAction,
  saveGitlabPatAction,
} from "./actions";
import {
  initialClearGithubPatState,
  initialClearGitlabPatState,
  initialSaveGithubPatState,
  initialSaveGitlabPatState,
} from "./state";
import { ProviderViewRow, AddProviderForm } from "./ai-providers";
import { FieldLabel, SavedSecret, type SecretFieldState } from "./fields";
import { type AiProviderSummary } from "./provider-edit-form";

interface SettingsFormProps {
  initialHasGithubPat: boolean;
  initialHasGitlabPat: boolean;
  initialProviders: AiProviderSummary[];
  initialActiveProviderId: string | null;
}

/** Section heading with a leading icon chip — shared by every card. */
export function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <CardTitle className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
      <span className="flex size-7 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border">
        <Icon className="size-3.5" />
      </span>
      {children}
    </CardTitle>
  );
}

// ---------------------------------------------------------------------------
// One saved provider: a view row, or (toggled) an inline edit form
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Add a new provider
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Top-level form
// ---------------------------------------------------------------------------

export function SettingsForm({
  initialHasGithubPat,
  initialHasGitlabPat,
  initialProviders,
  initialActiveProviderId,
}: SettingsFormProps) {
  const [patState, patFormAction, isPatSaving] = useActionState(
    saveGithubPatAction,
    initialSaveGithubPatState
  );
  const [clearPatState, clearPatFormAction, isClearingPat] = useActionState(
    clearGithubPatAction,
    initialClearGithubPatState
  );

  const [patFieldState, setPatFieldState] = useState<SecretFieldState>(
    initialHasGithubPat ? "saved" : "editing"
  );
  const [githubPat, setGithubPat] = useState("");

  useEffect(() => {
    if (patState.status !== "success" || !patState.githubPatUpdated) return;
    setPatFieldState("saved");
    setGithubPat("");
  }, [patState]);

  useEffect(() => {
    if (clearPatState.status === "success") setPatFieldState("editing");
  }, [clearPatState]);

  const [gitlabPatState, gitlabPatFormAction, isGitlabPatSaving] = useActionState(
    saveGitlabPatAction,
    initialSaveGitlabPatState
  );
  const [clearGitlabPatState, clearGitlabPatFormAction, isClearingGitlabPat] = useActionState(
    clearGitlabPatAction,
    initialClearGitlabPatState
  );

  const [gitlabPatFieldState, setGitlabPatFieldState] = useState<SecretFieldState>(
    initialHasGitlabPat ? "saved" : "editing"
  );
  const [gitlabPat, setGitlabPat] = useState("");

  useEffect(() => {
    if (gitlabPatState.status !== "success" || !gitlabPatState.gitlabPatUpdated) return;
    setGitlabPatFieldState("saved");
    setGitlabPat("");
  }, [gitlabPatState]);

  useEffect(() => {
    if (clearGitlabPatState.status === "success") setGitlabPatFieldState("editing");
  }, [clearGitlabPatState]);

  // Two columns of the settings page's grid (app/settings/page.tsx): the
  // git-host PATs, then the AI providers.
  return (
    <>
      <div className="min-w-0 space-y-5">
        <form action={patFormAction}>
          <Card className="[--card-spacing:--spacing(5)]">
            <CardHeader>
              <SectionTitle icon={Github}>GitHub</SectionTitle>
              <CardDescription className="text-[13px] leading-relaxed">
                Personal Access Token used to fetch repos, PRs, diffs, and linked
                issues.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <FieldLabel htmlFor="githubPat" hint="repo scope">
                  Personal Access Token
                </FieldLabel>
                {patFieldState === "saved" ? (
                  <SavedSecret
                    label="PAT"
                    onReplace={() => setPatFieldState("editing")}
                    clearAction={clearPatFormAction}
                    clearing={isClearingPat}
                  />
                ) : (
                  <Input
                    id="githubPat"
                    name="githubPat"
                    type="password"
                    autoComplete="off"
                    placeholder="ghp_..."
                    className="font-mono"
                    value={githubPat}
                    onChange={(e) => setGithubPat(e.target.value)}
                  />
                )}
              </div>
            </CardContent>
            <CardFooter className="flex items-center gap-3">
              <Button type="submit" size="sm" disabled={isPatSaving}>
                {isPatSaving ? (
                  <>
                    <LoaderCircle className="animate-spin" aria-hidden />
                    Saving…
                  </>
                ) : (
                  "Save"
                )}
              </Button>
              {patState.status === "success" && (
                <span className="flex items-center gap-1.5 text-[13px] text-success">
                  <Check className="size-4" aria-hidden />
                  Saved
                </span>
              )}
              {patState.status === "error" && (
                <span className="flex items-center gap-1.5 text-[13px] text-destructive">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  {patState.error}
                </span>
              )}
              {clearPatState.status === "error" && (
                <span className="flex items-center gap-1.5 text-[13px] text-destructive">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  {clearPatState.error}
                </span>
              )}
            </CardFooter>
          </Card>
        </form>

        <form action={gitlabPatFormAction}>
          <Card className="[--card-spacing:--spacing(5)]">
            <CardHeader>
              <SectionTitle icon={Gitlab}>GitLab</SectionTitle>
              <CardDescription className="text-[13px] leading-relaxed">
                Personal Access Token used to fetch repos, merge requests,
                diffs, and linked issues. For a self-hosted instance, also set{" "}
                <span className="font-mono text-foreground/80">GITLAB_API_URL</span>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <FieldLabel htmlFor="gitlabPat" hint="api scope">
                  Personal Access Token
                </FieldLabel>
                {gitlabPatFieldState === "saved" ? (
                  <SavedSecret
                    label="PAT"
                    onReplace={() => setGitlabPatFieldState("editing")}
                    clearAction={clearGitlabPatFormAction}
                    clearing={isClearingGitlabPat}
                  />
                ) : (
                  <Input
                    id="gitlabPat"
                    name="gitlabPat"
                    type="password"
                    autoComplete="off"
                    placeholder="glpat-..."
                    className="font-mono"
                    value={gitlabPat}
                    onChange={(e) => setGitlabPat(e.target.value)}
                  />
                )}
              </div>
            </CardContent>
            <CardFooter className="flex items-center gap-3">
              <Button type="submit" size="sm" disabled={isGitlabPatSaving}>
                {isGitlabPatSaving ? (
                  <>
                    <LoaderCircle className="animate-spin" aria-hidden />
                    Saving…
                  </>
                ) : (
                  "Save"
                )}
              </Button>
              {gitlabPatState.status === "success" && (
                <span className="flex items-center gap-1.5 text-[13px] text-success">
                  <Check className="size-4" aria-hidden />
                  Saved
                </span>
              )}
              {gitlabPatState.status === "error" && (
                <span className="flex items-center gap-1.5 text-[13px] text-destructive">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  {gitlabPatState.error}
                </span>
              )}
              {clearGitlabPatState.status === "error" && (
                <span className="flex items-center gap-1.5 text-[13px] text-destructive">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  {clearGitlabPatState.error}
                </span>
              )}
            </CardFooter>
          </Card>
        </form>
      </div>

      <div className="min-w-0">
        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <SectionTitle icon={Bot}>AI providers</SectionTitle>
            <CardDescription className="text-[13px] leading-relaxed">
              Save more than one OpenAI-compatible provider — e.g. a local
              model server and a hosted one — and toggle which is active. Only
              the active provider is used for reviews and labeling.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {initialProviders.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                No providers saved yet.
              </p>
            ) : (
              <div className="space-y-2">
                {initialProviders.map((provider) => (
                  <ProviderViewRow
                    key={provider.id}
                    provider={provider}
                    isActive={provider.id === initialActiveProviderId}
                  />
                ))}
              </div>
            )}

            <AddProviderForm />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
