"use client";

// The Graph tab's selected-component panel: the files
// that actually make up the component whose node was clicked in
// `GraphCanvas`, which the graph itself only ever shows as a *count* (node
// size, and the hover tooltip).
//
// Fetches `GET /api/repos/[repoId]/components/[componentId]/files` — see
// that route for the response shape. Sits above `DiffPanel` in GraphView's
// sidebar rather than replacing it, so selecting a node never hides the
// diff controls, and the panel carries its own "clear selection" affordance
// on top of tapping the graph background.

import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  FileCode2,
  GitMerge,
  LoaderCircle,
  Pencil,
  Sparkles,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { formatMember } from "./MergeSuggestions";
import {
  INTENT_VISUALS,
  compareIntent,
  effectiveIntent,
  formatConfidence,
  formatLocation,
} from "./review-visuals";
import type { ComponentFilesResponseDTO, FindingDTO } from "./types";

type FetchState =
  | { status: "loading" }
  | { status: "loaded"; data: ComponentFilesResponseDTO }
  | { status: "error"; message: string };

export interface ComponentFilesPanelProps {
  repoId: string;
  componentId: string;
  /** The name already known from the graph payload — shown immediately, before the fetch lands. */
  componentName: string;
  tier?: string;
  /** From the graph payload; the panel shows it while loading so the header doesn't jump. */
  fileCount?: number;
  description?: string;
  /** True when the canvas is showing `sample-data.ts` (no analyzed graph) — those component ids don't exist in Neo4j, so the fetch is skipped rather than 404'ing. */
  sampleData?: boolean;
  /**
   * File paths for a synthetic "added" node (a PR's new, not-yet-analyzed
   * files — see `AddedComponentDTO`). These never got a `(:File)` node
   * either, so the fetch is skipped the same way `sampleData` skips it;
   * the paths are rendered directly instead.
   */
  localFiles?: string[];
  /**
   * This component's AI review findings, already filtered by
   * the caller. Shown above the file list because the verdict is the reason
   * someone clicked the node in the first place; the files are the detail
   * underneath it. Not fetched here — `GraphView` already holds the whole
   * review, so re-fetching per selection would duplicate a poll.
   */
  findings?: FindingDTO[];
  /** Present when this node is a merged feature module (DESIGN.md §6.3). */
  merged?: MergedModuleActions;
  /** Rendered in the header before the clear button — GraphView's "Show in PR" / "Show in repo" switch. */
  headerAction?: React.ReactNode;
  onClear: () => void;
}

/** What the panel can do with a merged feature module. */
export interface MergedModuleActions {
  pathPatterns: string[];
  aiConfigured: boolean;
  busy: "unmerge" | "rename" | "naming" | null;
  onRename: (name: string) => Promise<boolean>;
  onNameWithAi: () => void;
  onUnmerge: () => Promise<boolean>;
}

export function ComponentFilesPanel({
  repoId,
  componentId,
  componentName,
  tier,
  fileCount,
  description,
  sampleData,
  localFiles,
  findings,
  merged,
  headerAction,
  onClear,
}: ComponentFilesPanelProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  // Worst first, same ordering rule as the review dock, so the two never
  // disagree about which finding is the headline for this component.
  const sortedFindings = useMemo(
    () =>
      [...(findings ?? [])].sort(
        (a, b) =>
          compareIntent(effectiveIntent(a), effectiveIntent(b)) ||
          compareIntent(a.intentMatch, b.intentMatch) ||
          b.confidence - a.confidence
      ),
    [findings]
  );

  useEffect(() => {
    let cancelled = false;
    if (localFiles) {
      setState({
        status: "loaded",
        data: {
          componentId,
          componentName,
          files: localFiles.map((path) => ({ id: path, path, language: "", loc: 0 })),
        },
      });
      return;
    }
    if (sampleData) {
      setState({
        status: "error",
        message:
          "This repo has no analyzed graph yet, so there are no real files behind the sample components.",
      });
      return;
    }
    setState({ status: "loading" });

    // Component ids are `<repoId>:<tier>:<name>` and the name is a folder
    // path, so they routinely contain `/` (and `:`) — without encoding,
    // `actions/collection` splits into two path segments and the route
    // 404s. Encoded (`%2F`), Next matches the segment and hands the
    // decoded id back through `params`.
    fetch(
      `/api/repos/${encodeURIComponent(repoId)}/components/${encodeURIComponent(
        componentId
      )}/files`
    )
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as
          | ComponentFilesResponseDTO
          | { error: string }
          | null;
        if (!res.ok || !json || "error" in json) {
          throw new Error(
            json && "error" in json ? json.error : `Request failed (${res.status}).`
          );
        }
        return json;
      })
      .then((data) => {
        if (!cancelled) setState({ status: "loaded", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message:
            err instanceof Error ? err.message : "Failed to load component files.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [repoId, componentId, componentName, sampleData, localFiles]);

  const files = state.status === "loaded" ? state.data.files : [];
  const count = state.status === "loaded" ? files.length : fileCount;

  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
      <div className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <Boxes className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold tracking-tight" title={componentName}>
            {componentName}
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {tier && (
              <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase">
                {tier}
              </span>
            )}
            <span>
              {count === undefined ? "…" : count} file
              {count === 1 ? "" : "s"}
            </span>
          </p>
        </div>
        {headerAction}
        <button
          type="button"
          onClick={onClear}
          className="-mr-1 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Clear selected component"
          title="Clear selection"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {description && (
        <p className="border-b border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}

      {merged && <MergedModuleSection name={componentName} actions={merged} />}

      {/*
        Compact review findings. Same badge colours/glyphs as the dock below
        the canvas (both read review-visuals.ts), just stripped to what fits
        a 320px sidebar: badge, summary, location. The full rationale stays
        in the dock — repeating it here would push the file list, which is
        this panel's actual job, off the screen.
      */}
      {sortedFindings.length > 0 && (
        <div className="border-b border-border bg-background/40">
          <p className="px-3 pt-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            AI review · {sortedFindings.length} finding
            {sortedFindings.length === 1 ? "" : "s"}
          </p>
          <ul className="max-h-[26vh] divide-y divide-border/60 overflow-y-auto">
            {sortedFindings.map((finding) => {
              const visual = INTENT_VISUALS[finding.intentMatch];
              const Icon = visual.icon;
              const location = formatLocation(finding);
              return (
                <li key={finding.id} className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium"
                      style={{
                        color: visual.text,
                        borderColor: `${visual.color}59`,
                        backgroundColor: `${visual.color}1f`,
                      }}
                      title={visual.description}
                    >
                      <Icon className="size-2.5" aria-hidden />
                      {visual.label}
                    </span>
                    {finding.resolvedAt ? (
                      <span className="text-[10px] font-medium text-success">
                        Resolved
                      </span>
                    ) : (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {formatConfidence(finding.confidence)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-foreground/85">
                    {finding.summary}
                  </p>
                  {location && (
                    <p
                      className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
                      title={location}
                    >
                      {location}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {state.status === "loading" && (
        <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          Loading files…
        </p>
      )}

      {state.status === "error" && (
        <p
          className={
            sampleData
              ? "flex items-start gap-2 px-3 py-3 text-xs text-muted-foreground"
              : "flex items-start gap-2 px-3 py-3 text-xs text-destructive"
          }
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{state.message}</span>
        </p>
      )}

      {state.status === "loaded" &&
        (files.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            No files are attached to this component.
          </p>
        ) : (
          // Capped and scrollable: a big module can own hundreds of files
          // and this panel shares a sticky sidebar with DiffPanel.
          <ul className="max-h-[38vh] divide-y divide-border/60 overflow-y-auto">
            {files.map((file) => (
              <li
                key={file.id}
                className="flex items-start gap-2 px-3 py-1.5 transition-colors hover:bg-secondary/50"
              >
                <FileCode2
                  className="mt-0.5 size-3 shrink-0 text-muted-foreground/70"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  {/* Split so the *filename* — the identifying part — is
                      always fully visible in a narrow sidebar, and it's the
                      leading directories that truncate. (A `dir="rtl"`
                      one-liner would do the same truncation but reorders
                      slash-separated segments visually, mangling the path.) */}
                  <p
                    className="flex items-baseline font-mono text-[11px]"
                    title={file.path}
                  >
                    {(() => {
                      const slash = file.path.lastIndexOf("/");
                      const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
                      const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
                      return (
                        <>
                          {dir && (
                            <span className="truncate text-muted-foreground/70">
                              {dir}
                            </span>
                          )}
                          <span className="shrink-0 text-foreground/90">
                            {base}
                          </span>
                        </>
                      );
                    })()}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span className="uppercase">{file.language}</span>
                    {file.loc > 0 && (
                      <>
                        <span className="opacity-40">·</span>
                        <span className="font-mono">{file.loc} LOC</span>
                      </>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/**
 * A merged feature module's members and actions. Unmerge asks for a second
 * click rather than a dialog: it is undoable (the suggestion can be
 * reopened and accepted again), just not in one step.
 */
function MergedModuleSection({ name, actions }: { name: string; actions: MergedModuleActions }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [confirmUnmerge, setConfirmUnmerge] = useState(false);
  const busy = actions.busy;
  const button =
    "flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50";

  return (
    <div className="border-b border-border px-3 py-2">
      <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        <GitMerge className="size-3 text-brand" aria-hidden />
        Merged feature · {actions.pathPatterns.length} member{actions.pathPatterns.length === 1 ? "" : "s"}
      </p>
      <ul className="mt-1 space-y-0.5">
        {actions.pathPatterns.map((pattern) => (
          <li key={pattern} className="truncate font-mono text-[11px] text-foreground/90" title={pattern}>
            {formatMember(pattern)}
          </li>
        ))}
      </ul>

      {editing ? (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await actions.onRename(draft)) setEditing(false);
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
            maxLength={60}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
            aria-label="Module name"
          />
          <button type="submit" disabled={busy !== null || !draft.trim()} className={button}>
            {busy === "rename" ? <LoaderCircle className="size-2.5 animate-spin" aria-hidden /> : null}
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className={button}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
            className={button}
          >
            <Pencil className="size-2.5" aria-hidden />
            Rename
          </button>
          {actions.aiConfigured && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={actions.onNameWithAi}
              className={button}
              title="Ask the AI provider for a name and description (one model call)"
            >
              {busy === "naming" ? (
                <LoaderCircle className="size-2.5 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="size-2.5 text-brand" aria-hidden />
              )}
              {busy === "naming" ? "Naming…" : "Name with AI"}
            </button>
          )}
          <button
            type="button"
            disabled={busy !== null}
            onClick={async () => {
              if (!confirmUnmerge) {
                setConfirmUnmerge(true);
                return;
              }
              await actions.onUnmerge();
            }}
            onBlur={() => setConfirmUnmerge(false)}
            className={confirmUnmerge ? `${button} border-destructive/50 text-destructive` : button}
            title="Split this back into its original folder modules"
          >
            {busy === "unmerge" ? (
              <LoaderCircle className="size-2.5 animate-spin" aria-hidden />
            ) : (
              <Undo2 className="size-2.5" aria-hidden />
            )}
            {confirmUnmerge ? "Click again to unmerge" : "Unmerge"}
          </button>
        </div>
      )}
    </div>
  );
}
