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
import { Bot, Check, ChevronRight, Github, Gitlab, LoaderCircle, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { clearGithubPatAction, clearGitlabPatAction, saveGithubPatAction, saveGitlabPatAction } from "./actions";
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
  const [patState, patFormAction, isPatSaving] = useActionState(saveGithubPatAction, initialSaveGithubPatState);
  const [clearPatState, clearPatFormAction, isClearingPat] = useActionState(
    clearGithubPatAction,
    initialClearGithubPatState
  );

  const [patFieldState, setPatFieldState] = useState<SecretFieldState>(initialHasGithubPat ? "saved" : "editing");
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
      {/* Both git hosts in one card, a row each: a token field with its Save beside it. */}
      <div id="git-hosts" className="min-w-0 scroll-mt-16">
        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <SectionTitle icon={Github}>Git hosts</SectionTitle>
            <CardDescription className="text-[13px] leading-relaxed">
              Personal Access Tokens for fetching repos, pull requests, diffs and linked issues.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <HostTokenRow
              id="githubPat"
              icon={Github}
              name="GitHub"
              hint="repo scope"
              placeholder="ghp_..."
              scopes={
                <>
                  <ScopeLine name="Classic token">
                    <Scope>repo</Scope> — private repos, pull requests, CI and posting reviews. <Scope>public_repo</Scope> is
                    enough if every repo you review is public.
                  </ScopeLine>
                  <ScopeLine name="Fine-grained token">
                    on the repos you review: <Scope>Contents</Scope>, <Scope>Metadata</Scope>, <Scope>Issues</Scope>,{" "}
                    <Scope>Checks</Scope>, <Scope>Commit statuses</Scope> and <Scope>Actions</Scope> read;{" "}
                    <Scope>Pull requests</Scope> read and write (write only to post reviews).
                  </ScopeLine>
                </>
              }
              formAction={patFormAction}
              fieldState={patFieldState}
              onReplace={() => setPatFieldState("editing")}
              value={githubPat}
              onChange={setGithubPat}
              saving={isPatSaving}
              state={patState}
              clearAction={clearPatFormAction}
              clearing={isClearingPat}
              clearState={clearPatState}
            />
            <HostTokenRow
              id="gitlabPat"
              icon={Gitlab}
              name="GitLab"
              hint="api scope"
              placeholder="glpat-..."
              scopes={
                <>
                  <ScopeLine name="Full">
                    <Scope>api</Scope> — merge requests, diffs, pipelines, private clones and posting reviews (with at least
                    Reporter access to the project).
                  </ScopeLine>
                  <ScopeLine name="Read-only">
                    <Scope>read_api</Scope> and <Scope>read_repository</Scope> — everything except posting reviews.
                  </ScopeLine>
                </>
              }
              note={
                <>
                  Self-hosted? Also set <span className="font-mono text-foreground/80">GITLAB_API_URL</span>.
                </>
              }
              formAction={gitlabPatFormAction}
              fieldState={gitlabPatFieldState}
              onReplace={() => setGitlabPatFieldState("editing")}
              value={gitlabPat}
              onChange={setGitlabPat}
              saving={isGitlabPatSaving}
              state={gitlabPatState}
              clearAction={clearGitlabPatFormAction}
              clearing={isClearingGitlabPat}
              clearState={clearGitlabPatState}
            />
          </CardContent>
        </Card>
      </div>

      <div id="ai-providers" className="min-w-0 scroll-mt-16">
        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <SectionTitle icon={Bot}>AI providers</SectionTitle>
            <CardDescription className="text-[13px] leading-relaxed">
              Save more than one OpenAI-compatible provider — e.g. a local model server and a hosted one — and toggle
              which is active. Only the active provider is used for reviews and labeling.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {initialProviders.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No providers saved yet.</p>
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

/** One git host's token: label, then the field (or the saved marker) with Save beside it, then any message. */
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

function HostTokenRow({
  id,
  icon: Icon,
  name,
  hint,
  placeholder,
  scopes,
  note,
  formAction,
  fieldState,
  onReplace,
  value,
  onChange,
  saving,
  state,
  clearAction,
  clearing,
  clearState,
}: {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  hint: string;
  placeholder: string;
  /** What the token needs, folded under the host's name. */
  scopes?: React.ReactNode;
  note?: React.ReactNode;
  formAction: (payload: FormData) => void;
  fieldState: SecretFieldState;
  onReplace: () => void;
  value: string;
  onChange: (value: string) => void;
  saving: boolean;
  state: { status: string; error?: string };
  clearAction: (payload: FormData) => void;
  clearing: boolean;
  clearState: { status: string; error?: string };
}) {
  const error = state.status === "error" ? state.error : clearState.status === "error" ? clearState.error : null;
  return (
    <form action={formAction} className="space-y-2">
      <FieldLabel htmlFor={id} hint={hint}>
        <span className="flex items-center gap-1.5">
          <Icon className="size-3.5 opacity-70" />
          {name}
        </span>
      </FieldLabel>
      {scopes && (
        <details className="group/scopes text-xs text-muted-foreground">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open/scopes:rotate-90" aria-hidden />
            Required scopes
          </summary>
          <div className="mt-1.5 space-y-1.5 border-l border-border pl-3 leading-relaxed">{scopes}</div>
        </details>
      )}
      {fieldState === "saved" ? (
        <SavedSecret label="PAT" onReplace={onReplace} clearAction={clearAction} clearing={clearing} />
      ) : (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            name={id}
            type="password"
            autoComplete="off"
            placeholder={placeholder}
            className="font-mono"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? <LoaderCircle className="animate-spin" aria-label="Saving" /> : "Save"}
          </Button>
        </div>
      )}
      {state.status === "success" && fieldState !== "saved" && (
        <p className="flex items-center gap-1.5 text-[13px] text-success">
          <Check className="size-4" aria-hidden />
          Saved
        </p>
      )}
      {error && (
        <p className="flex items-center gap-1.5 text-[13px] text-destructive">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </form>
  );
}
