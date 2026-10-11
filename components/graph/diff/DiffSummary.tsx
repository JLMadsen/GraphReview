"use client";

// The one-line summary of the selected diff under the diff picker.

import { ChevronsUpDown, LoaderCircle } from "lucide-react";
import { formatRelativeDate, isShaLike, shortRef } from "../types";
import type {
  DiffImpactRequestDTO,
  DiffImpactResponseDTO,
} from "../types";
import { type DiffTargetMeta } from "../DiffPanel";
import { type PullRequestOption } from "./options";

/** The folded-away picker: what was checked, how big it is, and what isn't on the map. */
export function DiffSummary({
  result,
  checked,
  meta,
  lastAnalyzedSha,
  pr,
  lineStats,
  loading,
  onChange,
  headline,
  children,
}: {
  result: DiffImpactResponseDTO;
  checked: DiffImpactRequestDTO;
  meta: DiffTargetMeta;
  lastAnalyzedSha?: string;
  /** The PR's summary from the list, when the check was of a PR that is in it. */
  pr?: PullRequestOption;
  lineStats?: { additions: number; deletions: number } | null;
  loading: boolean;
  onChange: () => void;
  headline?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const kind = "prNumber" in checked ? "Pull request" : "baseRef" in checked ? (isShaLike(checked.headRef) ? "Commits" : "Branches") : "Files";
  // One file count for the whole page: every file in the diff, on the map or not.
  const files = result.touchedFiles.length + result.unmatchedFiles.length;

  const prState = pr ? (pr.state === "open" && pr.draft ? "draft" : pr.state) : null;
  const prWhen = pr ? formatRelativeDate(pr.state === "open" ? pr.createdAt ?? pr.updatedAt : pr.updatedAt) : "";

  return (
    <div className="text-xs">
      {/* What is being looked at, as the picker it reopens. */}
      <button
        type="button"
        onClick={onChange}
        className="flex w-full items-start gap-2 rounded-md border border-border bg-background/40 px-2.5 py-2 text-left transition-colors hover:border-foreground/25 hover:bg-background/70"
        title={`${kind} — pick another diff`}
      >
        <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug font-medium">
          {"prNumber" in checked ? (
            <>
              <span className="font-mono font-normal text-muted-foreground">#{checked.prNumber}</span>{" "}
              {pr?.title ?? "Pull request"}
            </>
          ) : "baseRef" in checked ? (
            <span className="font-mono text-xs">
              {shortRef(checked.baseRef)} <span className="text-muted-foreground">→</span> {shortRef(checked.headRef)}
            </span>
          ) : (
            "Pasted paths"
          )}
        </span>
        {loading ? (
          <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Checking" />
        ) : (
          <ChevronsUpDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>

      <div className="mt-2.5 space-y-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {pr ? (
          <>
            <p className="truncate">
              {pr.author ?? "unknown"} · {prState}
              {prWhen ? ` ${prWhen}` : ""}
            </p>
            {pr.headRef && pr.baseRef && (
              <p className="truncate" title={`${pr.headRef} → ${pr.baseRef}`}>
                {pr.headRef} → {pr.baseRef}
              </p>
            )}
          </>
        ) : null}
        <p>
          {pr ? "" : `${kind} · `}
          {files} file{files === 1 ? "" : "s"} · {result.touchedComponentIds.length} component
          {result.touchedComponentIds.length === 1 ? "" : "s"}
        </p>
        {lineStats && (
          <p>
            <span className="text-success">+{lineStats.additions.toLocaleString("en-US")}</span>{" "}
            <span className="text-destructive">−{lineStats.deletions.toLocaleString("en-US")}</span>
          </p>
        )}
      </div>
      {meta.historical && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          History, mapped onto the graph at{" "}
          <span className="font-mono">{lastAnalyzedSha ? shortRef(lastAnalyzedSha) : "the latest analysis"}</span>.
        </p>
      )}

      {(headline || children) && (
        <div className="mt-3 border-t border-border pt-3">
          {headline}
          {children}
        </div>
      )}

    </div>
  );
}
