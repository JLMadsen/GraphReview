"use client";

// The "view diff" action behind a finding in `ReviewPanel`: fetches
// `GET /api/repos/[repoId]/diff-impact/file` for the
// finding's `filePath` against the review's own target (PR or refs) and
// renders it in `DiffViewer`, with the finding's `lineRange` highlighted so
// a reviewer can find the spot the finding is actually about inside a
// larger file.
//
// One modal instance lives in `ReviewPanel`, driven by which finding (if
// any) is "open" — not one per finding — so opening a second diff replaces
// the first rather than stacking dialogs.

import { useEffect, useState } from "react";
import { FileDiff, LoaderCircle, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DiffViewer } from "./DiffViewer";
import { parseLineRange, parseUnifiedDiff } from "./diff-utils";
import type { FileDiffResponseDTO, FindingDTO, ReviewTargetDTO } from "./types";

function diffQuery(target: ReviewTargetDTO, filePath: string): string {
  const params = new URLSearchParams({ path: filePath });
  if ("prNumber" in target) {
    params.set("prNumber", String(target.prNumber));
  } else {
    params.set("baseRef", target.baseRef);
    params.set("headRef", target.headRef);
  }
  return params.toString();
}

type FetchState =
  | { status: "loading" }
  | { status: "loaded"; data: FileDiffResponseDTO }
  | { status: "error"; message: string };

export interface FileDiffModalProps {
  repoId: string;
  target: ReviewTargetDTO;
  /** The finding whose file to show, or `null` when the modal is closed. */
  finding: FindingDTO | null;
  onClose: () => void;
}

export function FileDiffModal({ repoId, target, finding, onClose }: FileDiffModalProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const filePath = finding?.filePath;

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    setState({ status: "loading" });
    fetch(`/api/repos/${repoId}/diff-impact/file?${diffQuery(target, filePath)}`)
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as
          | FileDiffResponseDTO
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
          message: err instanceof Error ? err.message : "Failed to load the diff.",
        });
      });
    return () => {
      cancelled = true;
    };
    // `target` is fixed for the lifetime of a review dock — only the
    // selected finding's file ever changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, filePath]);

  const highlightRange = parseLineRange(finding?.lineRange);

  return (
    <Dialog open={Boolean(finding)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-[calc(100%-2rem)] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 font-mono text-[13px] font-normal">
            <FileDiff className="size-4 shrink-0 text-brand" aria-hidden />
            <span className="truncate" title={filePath}>
              {filePath}
            </span>
            {state.status === "loaded" && (
              <span className="ml-auto shrink-0 font-sans text-[11px] font-normal text-muted-foreground">
                <span className="text-success">+{state.data.additions}</span>{" "}
                <span className="text-destructive">-{state.data.deletions}</span>
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {state.status === "loading" && (
            <p className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              Loading diff…
            </p>
          )}
          {state.status === "error" && (
            <p className="flex items-start gap-2 px-1 py-6 text-xs text-destructive">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>{state.message}</span>
            </p>
          )}
          {state.status === "loaded" &&
            (state.data.patch ? (
              <DiffViewer
                hunks={parseUnifiedDiff(state.data.patch)}
                highlightRange={highlightRange}
              />
            ) : (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                {state.data.status === "added" || state.data.status === "removed"
                  ? `File was ${state.data.status}; no line-by-line diff to show.`
                  : "No textual diff for this file (binary, or too large)."}
              </p>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
