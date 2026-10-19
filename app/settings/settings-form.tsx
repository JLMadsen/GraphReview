"use client";

// Client half of the settings screen.
//
// Secret fields (AI provider API keys) never round-trip a
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

import { Bot } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProviderViewRow, AddProviderForm } from "./ai-providers";
import { type AiProviderSummary } from "./provider-edit-form";

interface SettingsFormProps {
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
  initialProviders,
  initialActiveProviderId,
}: SettingsFormProps) {
  // One column of the settings page's grid (app/settings/page.tsx); the git
  // servers card (./git-servers-card.tsx) is the one before it.
  return (
    <>
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

