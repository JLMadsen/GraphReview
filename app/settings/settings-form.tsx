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
  Circle,
  CircleCheck,
  Github,
  Gitlab,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
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
  createAiProviderAction,
  deleteAiProviderAction,
  saveGithubPatAction,
  saveGitlabPatAction,
  setActiveAiProviderAction,
  testAiConnectionAction,
  updateAiProviderAction,
} from "./actions";
import {
  initialClearGithubPatState,
  initialClearGitlabPatState,
  initialDeleteAiProviderState,
  initialSaveAiProviderState,
  initialSaveGithubPatState,
  initialSaveGitlabPatState,
  initialSetActiveAiProviderState,
  initialTestConnectionState,
} from "./state";
import type { TestConnectionState } from "./state";

type SecretFieldState = "saved" | "editing";

export interface AiProviderSummary {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

interface SettingsFormProps {
  initialHasGithubPat: boolean;
  initialHasGitlabPat: boolean;
  initialProviders: AiProviderSummary[];
  initialActiveProviderId: string | null;
}

/** Section heading with a leading icon chip — shared by every card. */
function SectionTitle({
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

function FieldLabel({
  htmlFor,
  children,
  hint,
}: {
  htmlFor: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-[13px] font-medium">
        {children}
      </label>
      {hint ? (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

/**
 * The masked "already saved" row for a secret, with its two escape hatches:
 * Replace (type a new value) and Clear (delete the stored one outright).
 */
function SavedSecret({
  label,
  onReplace,
  clearAction,
  clearing,
}: {
  label: string;
  onReplace: () => void;
  clearAction: (formData: FormData) => void;
  clearing: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-success/25 bg-success/8 px-2.5 py-1.5">
      <span className="flex min-w-0 items-center gap-2 text-[13px] text-success">
        <ShieldCheck className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{label} saved</span>
        <span className="font-mono text-muted-foreground" aria-hidden>
          ••••••••
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <Button type="button" variant="outline" size="xs" onClick={onReplace}>
          Replace
        </Button>
        <Button
          type="submit"
          variant="ghost"
          size="xs"
          formAction={clearAction}
          formNoValidate
          disabled={clearing}
          className="text-muted-foreground hover:text-destructive"
          title={`Delete the saved ${label.toLowerCase()} from this instance`}
        >
          {clearing ? (
            <LoaderCircle className="animate-spin" aria-hidden />
          ) : (
            <Trash2 aria-hidden />
          )}
          Clear
        </Button>
      </span>
    </div>
  );
}

/** "Sends one tiny chat completion" test-connection result strip, shared by every provider form. */
function TestConnectionResult({ testState }: { testState: TestConnectionState }) {
  if (testState.status === "ok") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-success">
        <Check className="size-4 shrink-0" aria-hidden />
        <span className="truncate">
          Reachable in {testState.latencyMs}ms
          {testState.model ? ` · ${testState.model}` : ""}
          {testState.usedSavedKey ? " · saved key" : ""}
        </span>
      </span>
    );
  }
  if (testState.status === "error") {
    return (
      <span className="flex min-w-0 items-start gap-1.5 text-[13px] text-destructive">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{testState.error}</span>
      </span>
    );
  }
  return (
    <span className="text-[13px] text-muted-foreground">
      Sends one tiny chat completion. Nothing is saved.
    </span>
  );
}

// ---------------------------------------------------------------------------
// One saved provider: a view row, or (toggled) an inline edit form
// ---------------------------------------------------------------------------

function ProviderEditForm({
  provider,
  onCancel,
  onSaved,
}: {
  provider: AiProviderSummary;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const updateAction = updateAiProviderAction.bind(null, provider.id);
  const [saveState, saveFormAction, isSaving] = useActionState(
    updateAction,
    initialSaveAiProviderState
  );
  const [testState, testFormAction, isTesting] = useActionState(
    testAiConnectionAction,
    initialTestConnectionState
  );

  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyState, setApiKeyState] = useState<SecretFieldState>(
    provider.hasApiKey ? "saved" : "editing"
  );

  useEffect(() => {
    if (saveState.status !== "success") return;
    onSaved();
  }, [saveState, onSaved]);

  return (
    <form
      action={saveFormAction}
      className="space-y-3 rounded-lg border border-border bg-secondary/40 p-3"
    >
      <input type="hidden" name="providerId" value={provider.id} />

      <div className="space-y-2">
        <FieldLabel htmlFor={`name-${provider.id}`}>Name</FieldLabel>
        <Input
          id={`name-${provider.id}`}
          name="name"
          autoComplete="off"
          placeholder="Local Ollama"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <FieldLabel htmlFor={`baseUrl-${provider.id}`}>Base URL</FieldLabel>
        <Input
          id={`baseUrl-${provider.id}`}
          name="baseUrl"
          autoComplete="off"
          placeholder="https://api.openai.com/v1"
          className="font-mono"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <FieldLabel htmlFor={`apiKey-${provider.id}`}>API key</FieldLabel>
        {apiKeyState === "saved" ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <ShieldCheck className="size-4 shrink-0" aria-hidden />
              Key saved
              <span className="font-mono" aria-hidden>
                ••••••••
              </span>
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setApiKeyState("editing")}
            >
              Replace
            </Button>
          </div>
        ) : (
          <Input
            id={`apiKey-${provider.id}`}
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder="sk-..."
            className="font-mono"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        )}
      </div>

      <div className="space-y-2">
        <FieldLabel htmlFor={`model-${provider.id}`}>Model name</FieldLabel>
        <Input
          id={`model-${provider.id}`}
          name="model"
          autoComplete="off"
          placeholder="gpt-4o-mini"
          className="font-mono"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3">
        <Button
          type="submit"
          variant="outline"
          size="sm"
          formAction={testFormAction}
          formNoValidate
          disabled={isTesting}
        >
          {isTesting ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden />
              Testing…
            </>
          ) : (
            <>
              <PlugZap aria-hidden />
              Test connection
            </>
          )}
        </Button>
        <TestConnectionResult testState={testState} />
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Button type="submit" size="sm" disabled={isSaving}>
          {isSaving ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden />
              Saving…
            </>
          ) : (
            "Save"
          )}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <X aria-hidden />
          Cancel
        </Button>
        {saveState.status === "error" && (
          <span className="flex items-center gap-1.5 text-[13px] text-destructive">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            {saveState.error}
          </span>
        )}
      </div>
    </form>
  );
}

function ProviderViewRow({
  provider,
  isActive,
}: {
  provider: AiProviderSummary;
  isActive: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const activateAction = setActiveAiProviderAction.bind(null, provider.id);
  const [activateState, activateFormAction, isActivating] = useActionState(
    activateAction,
    initialSetActiveAiProviderState
  );

  const deleteAction = deleteAiProviderAction.bind(null, provider.id);
  const [deleteState, deleteFormAction, isDeleting] = useActionState(
    deleteAction,
    initialDeleteAiProviderState
  );

  const [testState, testFormAction, isTesting] = useActionState(
    testAiConnectionAction,
    initialTestConnectionState
  );

  if (editing) {
    return (
      <ProviderEditForm
        provider={provider}
        onCancel={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {isActive ? (
            <span
              className="flex size-5 shrink-0 items-center justify-center text-success"
              title="Active provider"
            >
              <CircleCheck className="size-5" aria-hidden />
            </span>
          ) : (
            <form action={activateFormAction}>
              <button
                type="submit"
                disabled={isActivating}
                className="flex size-5 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                title="Use this provider"
              >
                {isActivating ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Circle className="size-5" aria-hidden />
                )}
              </button>
            </form>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">
                {provider.name}
              </span>
              {isActive && (
                <span className="shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
                  Active
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[12px] text-muted-foreground">
              {provider.baseUrl} · {provider.model}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setEditing(true)}
            title="Edit"
          >
            <Pencil aria-hidden />
          </Button>
          {confirmingDelete ? (
            <form action={deleteFormAction} className="flex items-center gap-1">
              <Button
                type="submit"
                variant="destructive"
                size="xs"
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <LoaderCircle className="animate-spin" aria-hidden />
                ) : (
                  "Confirm delete"
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setConfirmingDelete(false)}
                title="Cancel"
              >
                <X aria-hidden />
              </Button>
            </form>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setConfirmingDelete(true)}
              className="text-muted-foreground hover:text-destructive"
              title="Delete"
            >
              <Trash2 aria-hidden />
            </Button>
          )}
        </div>
      </div>

      <form action={testFormAction} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <input type="hidden" name="providerId" value={provider.id} />
        <Button
          type="submit"
          variant="outline"
          size="xs"
          disabled={isTesting}
        >
          {isTesting ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden />
              Testing…
            </>
          ) : (
            <>
              <PlugZap aria-hidden />
              Test
            </>
          )}
        </Button>
        {testState.status !== "idle" && <TestConnectionResult testState={testState} />}
      </form>

      {activateState.status === "error" && (
        <p className="flex items-start gap-1.5 text-[13px] text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {activateState.error}
        </p>
      )}
      {deleteState.status === "error" && (
        <p className="flex items-start gap-1.5 text-[13px] text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {deleteState.error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add a new provider
// ---------------------------------------------------------------------------

function AddProviderForm() {
  const [open, setOpen] = useState(false);
  const [saveState, saveFormAction, isSaving] = useActionState(
    createAiProviderAction,
    initialSaveAiProviderState
  );
  const [testState, testFormAction, isTesting] = useActionState(
    testAiConnectionAction,
    initialTestConnectionState
  );

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");

  useEffect(() => {
    if (saveState.status !== "success") return;
    setName("");
    setBaseUrl("");
    setApiKey("");
    setModel("");
    setOpen(false);
  }, [saveState]);

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus aria-hidden />
        Add provider
      </Button>
    );
  }

  return (
    <form
      action={saveFormAction}
      className="space-y-3 rounded-lg border border-dashed border-border p-3"
    >
      <div className="space-y-2">
        <FieldLabel htmlFor="new-name">Name</FieldLabel>
        <Input
          id="new-name"
          name="name"
          autoComplete="off"
          placeholder="Local Ollama"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <FieldLabel htmlFor="new-baseUrl">Base URL</FieldLabel>
        <Input
          id="new-baseUrl"
          name="baseUrl"
          autoComplete="off"
          placeholder="http://localhost:11434/v1"
          className="font-mono"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <FieldLabel htmlFor="new-apiKey">API key</FieldLabel>
        <Input
          id="new-apiKey"
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder="sk-... (any placeholder if the server doesn't check one)"
          className="font-mono"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <FieldLabel htmlFor="new-model">Model name</FieldLabel>
        <Input
          id="new-model"
          name="model"
          autoComplete="off"
          placeholder="gpt-4o-mini"
          className="font-mono"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3">
        <Button
          type="submit"
          variant="outline"
          size="sm"
          formAction={testFormAction}
          formNoValidate
          disabled={isTesting}
        >
          {isTesting ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden />
              Testing…
            </>
          ) : (
            <>
              <PlugZap aria-hidden />
              Test connection
            </>
          )}
        </Button>
        <TestConnectionResult testState={testState} />
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Button type="submit" size="sm" disabled={isSaving}>
          {isSaving ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden />
              Saving…
            </>
          ) : (
            "Save provider"
          )}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          <X aria-hidden />
          Cancel
        </Button>
        {saveState.status === "error" && (
          <span className="flex items-center gap-1.5 text-[13px] text-destructive">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            {saveState.error}
          </span>
        )}
      </div>
    </form>
  );
}

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

  return (
    <div className="space-y-5">
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
  );
}
