"use client";

// Field pieces shared by the settings forms.

import {
  LoaderCircle,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export type SecretFieldState = "saved" | "editing";

export function FieldLabel({
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
export function SavedSecret({
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
