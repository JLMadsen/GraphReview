"use client";

// Client half of the settings screen (DESIGN.md §4, §11).
//
// Secret fields (GitHub PAT, AI provider API key) never round-trip a
// decrypted value from the server: the server only tells this component
// whether a secret is currently saved. When one is saved, it renders as a
// masked badge with a "Replace" action rather than a pre-filled password
// input — clicking "Replace" swaps in a blank input for fresh entry. Only
// on submit does a freshly-typed secret leave the browser, straight into
// the saveSettingsAction server action (never persisted client-side first).
//
// Three server actions, one form. Save is the form's own `action`; "Test
// connection" and "Clear" are buttons carrying their own `formAction`,
// which is what lets them see the values currently typed in this form
// (React 19 submits the whole form to whichever action the clicked button
// names). Each has its own `useActionState`, so their results render
// independently instead of one overwriting the other's message.
//
// Every input is *controlled*, and that is load-bearing rather than taste:
// React 19 automatically resets a form's uncontrolled fields once an action
// finishes. With `defaultValue`, clicking "Test connection" emptied the base
// URL and model name the moment the ping came back — you'd verify an
// endpoint and be left with a blank form to retype before you could save it.
// Controlled state survives the reset. The two secret inputs are controlled
// for the same reason (a freshly typed key must outlive a test), and their
// state is cleared the instant the field collapses back to its masked row,
// so a plaintext secret never outlives the input that holds it. Nothing is
// written anywhere outside React state — see the note above about secrets
// never being persisted client-side.

import { useActionState, useEffect, useState } from "react";
import {
  Bot,
  Check,
  Github,
  LoaderCircle,
  PlugZap,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  clearCredentialAction,
  saveSettingsAction,
  testAiConnectionAction,
} from "./actions";
import {
  initialClearCredentialState,
  initialSaveSettingsState,
  initialTestConnectionState,
} from "./state";

type SecretFieldState = "saved" | "editing";

interface SettingsFormProps {
  initialHasGithubPat: boolean;
  initialHasAiApiKey: boolean;
  initialAiBaseUrl: string;
  initialAiModel: string;
}

/** Section heading with a leading icon chip — shared by both cards. */
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
 * The masked "already saved" row, with its two escape hatches: Replace
 * (type a new value) and Clear (delete the stored one outright — the
 * `clearCredentialAction` path, since an empty input on save means "keep").
 */
function SavedSecret({
  label,
  onReplace,
  clearAction,
  clearing,
}: {
  label: string;
  onReplace: () => void;
  /** A `clearCredentialAction` already bound to this credential — see that action's comment. */
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

export function SettingsForm({
  initialHasGithubPat,
  initialHasAiApiKey,
  initialAiBaseUrl,
  initialAiModel,
}: SettingsFormProps) {
  const [state, formAction, isPending] = useActionState(
    saveSettingsAction,
    initialSaveSettingsState
  );
  const [testState, testAction, isTesting] = useActionState(
    testAiConnectionAction,
    initialTestConnectionState
  );
  // One hook per credential, each with the field bound into the action (see
  // `clearCredentialAction`). Separate hooks also mean a failure on one card
  // can't paint an error next to the other one.
  const [clearPatState, clearPatAction, isClearingPat] = useActionState(
    clearCredentialAction.bind(null, "githubPat"),
    initialClearCredentialState
  );
  const [clearKeyState, clearKeyAction, isClearingKey] = useActionState(
    clearCredentialAction.bind(null, "aiApiKey"),
    initialClearCredentialState
  );

  const [patState, setPatState] = useState<SecretFieldState>(
    initialHasGithubPat ? "saved" : "editing"
  );
  const [apiKeyState, setApiKeyState] = useState<SecretFieldState>(
    initialHasAiApiKey ? "saved" : "editing"
  );

  const [githubPat, setGithubPat] = useState("");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiBaseUrl, setAiBaseUrl] = useState(initialAiBaseUrl);
  const [aiModel, setAiModel] = useState(initialAiModel);

  // After a successful save that included a freshly-typed secret, collapse
  // that field back to the masked "saved" state so the plaintext isn't
  // left sitting in the input — and drop it from state at the same moment,
  // so "Replace" always opens an empty box rather than the last value.
  useEffect(() => {
    if (state.status !== "success") return;
    if (state.githubPatUpdated) {
      setPatState("saved");
      setGithubPat("");
    }
    if (state.aiApiKeyUpdated) {
      setApiKeyState("saved");
      setAiApiKey("");
    }
  }, [state]);

  // A cleared credential has to flip its field back to the blank input:
  // `revalidatePath` re-renders the server page, but this client component
  // keeps its own state across that, so the props alone would leave a
  // "PAT saved" badge sitting over a property that no longer exists.
  useEffect(() => {
    if (clearPatState.status === "success") setPatState("editing");
  }, [clearPatState]);
  useEffect(() => {
    if (clearKeyState.status === "success") setApiKeyState("editing");
  }, [clearKeyState]);

  return (
    <form action={formAction} className="space-y-5">
      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <SectionTitle icon={Github}>GitHub</SectionTitle>
          <CardDescription className="text-[13px] leading-relaxed">
            Personal Access Token used to fetch repos, PRs, diffs, and linked
            issues (decision #7).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <FieldLabel htmlFor="githubPat" hint="repo scope">
              Personal Access Token
            </FieldLabel>
            {patState === "saved" ? (
              <SavedSecret
                label="PAT"
                onReplace={() => setPatState("editing")}
                clearAction={clearPatAction}
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
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <SectionTitle icon={Bot}>AI provider</SectionTitle>
          <CardDescription className="text-[13px] leading-relaxed">
            Base URL, API key, and model name for any OpenAI-compatible
            chat-completions endpoint (decision #8).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <FieldLabel htmlFor="aiBaseUrl">Base URL</FieldLabel>
            <Input
              id="aiBaseUrl"
              name="aiBaseUrl"
              type="text"
              autoComplete="off"
              placeholder="https://api.openai.com/v1"
              className="font-mono"
              value={aiBaseUrl}
              onChange={(e) => setAiBaseUrl(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <FieldLabel htmlFor="aiApiKey">API key</FieldLabel>
            {apiKeyState === "saved" ? (
              <SavedSecret
                label="API key"
                onReplace={() => setApiKeyState("editing")}
                clearAction={clearKeyAction}
                clearing={isClearingKey}
              />
            ) : (
              <Input
                id="aiApiKey"
                name="aiApiKey"
                type="password"
                autoComplete="off"
                placeholder="sk-..."
                className="font-mono"
                value={aiApiKey}
                onChange={(e) => setAiApiKey(e.target.value)}
              />
            )}
          </div>

          <div className="space-y-2">
            <FieldLabel htmlFor="aiModel">Model name</FieldLabel>
            <Input
              id="aiModel"
              name="aiModel"
              type="text"
              autoComplete="off"
              placeholder="gpt-4o-mini"
              className="font-mono"
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
            />
          </div>

          {/*
            Test connection. `formNoValidate` + `formAction` means this
            submits the form to the ping action instead of the save action,
            so it tests exactly what is on screen — including a base URL or
            model you haven't committed yet. It deliberately saves nothing:
            "does this endpoint answer?" and "make this my configuration"
            are different decisions.
          */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-4">
            <Button
              type="submit"
              variant="outline"
              size="sm"
              formAction={testAction}
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

            {testState.status === "ok" && (
              <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-success">
                <Check className="size-4 shrink-0" aria-hidden />
                <span className="truncate">
                  Reachable in {testState.latencyMs}
                  ms
                  {testState.model ? ` · ${testState.model}` : ""}
                  {testState.usedSavedKey ? " · saved key" : ""}
                </span>
              </span>
            )}
            {testState.status === "error" && (
              <span className="flex min-w-0 items-start gap-1.5 text-[13px] text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">{testState.error}</span>
              </span>
            )}
            {testState.status === "idle" && (
              <span className="text-[13px] text-muted-foreground">
                Sends one tiny chat completion. Nothing is saved.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {[clearPatState, clearKeyState].map((clearState, index) =>
        clearState.status === "error" ? (
          <p
            key={index}
            className="flex items-start gap-1.5 text-[13px] text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {clearState.error}
          </p>
        ) : null
      )}

      <div className="flex items-center gap-3 border-t border-border pt-5">
        <Button type="submit" disabled={isPending}>
          {isPending ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden />
              Saving…
            </>
          ) : (
            "Save settings"
          )}
        </Button>
        {state.status === "success" && (
          <span className="flex items-center gap-1.5 text-[13px] text-success">
            <Check className="size-4" aria-hidden />
            Saved
          </span>
        )}
        {state.status === "error" && (
          <span className="flex items-center gap-1.5 text-[13px] text-destructive">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
