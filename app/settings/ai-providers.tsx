"use client";

// The AI provider list in settings: one row per provider, and the form that adds one.

import { useActionState, useEffect, useState } from "react";
import {
  Check,
  Circle,
  FolderSearch,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createAiProviderAction,
  deleteAiProviderAction,
  setActiveAiProviderAction,
  testAiConnectionAction,
} from "./actions";
import {
  initialDeleteAiProviderState,
  initialSaveAiProviderState,
  initialSetActiveAiProviderState,
  initialTestConnectionState,
} from "./state";
import { type AiProviderSummary, ProviderEditForm, TestConnectionResult } from "./provider-edit-form";
import { FieldLabel } from "./fields";
import { LocalConfigImport } from "./local-config-import";

export function ProviderViewRow({
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
              <Check className="size-5" aria-hidden />
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

export function AddProviderForm() {
  const [open, setOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
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

  if (localOpen) {
    return <LocalConfigImport onClose={() => setLocalOpen(false)} />;
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Plus aria-hidden />
          Add provider
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setLocalOpen(true)}>
          <FolderSearch aria-hidden />
          Use local config
        </Button>
      </div>
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
