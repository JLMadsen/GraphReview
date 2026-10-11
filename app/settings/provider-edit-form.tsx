"use client";

// Editing one AI provider in settings, and the result of testing its connection.

import { useActionState, useEffect, useState } from "react";
import {
  Check,
  LoaderCircle,
  PlugZap,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  testAiConnectionAction,
  updateAiProviderAction,
} from "./actions";
import {
  initialSaveAiProviderState,
  initialTestConnectionState,
} from "./state";
import type { TestConnectionState } from "./state";
import { FieldLabel, type SecretFieldState } from "./fields";

export interface AiProviderSummary {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

/** "Sends one tiny chat completion" test-connection result strip, shared by every provider form. */
export function TestConnectionResult({ testState }: { testState: TestConnectionState }) {
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

export function ProviderEditForm({
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
