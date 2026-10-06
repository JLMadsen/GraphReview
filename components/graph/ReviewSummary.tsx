"use client";

// The review's verdict, at the top of the diff summary in the left column
// (DESIGN.md §6.6): "17 need a look" in the worst open verdict's colour,
// the breakdown under it, and the PR-level "delivers what it describes?"
// answer. The review dock under the map is the list; this is the result.

import { useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { Spark } from "./Spark";
import { emptyCounts, findingBucket, isAreaFinding } from "./pr-areas";
import { ASSESSMENT_VISUALS, REVIEW_ADVISORY, formatConfidence, isIntentFinding } from "./review-visuals";
import type { Assessment, FindingDTO, ReviewProgressDTO, ReviewStateDTO } from "./types";

/** The PR-level verdict as one word. */
const INTENT_WORDS: Record<Assessment, string> = {
  ok: "Yes.",
  concern: "Mostly.",
  defect: "No.",
  unknown: "Can't tell.",
};

export interface ReviewSummaryProps {
  status: "idle" | "loading" | "ready" | "error";
  state: ReviewStateDTO;
  progress?: ReviewProgressDTO;
  findings: FindingDTO[];
  aiConfigured: boolean;
}

export function ReviewSummary({ status, state, progress, findings, aiConfigured }: ReviewSummaryProps) {
  const [showWhy, setShowWhy] = useState(false);
  const running = state === "queued" || state === "running";
  const counts = emptyCounts();
  for (const f of findings) if (isAreaFinding(f)) counts[findingBucket(f)] += 1;
  const open = counts.defect + counts.concern + counts.unknown;
  const judged = open + counts.fine;
  const worst: Assessment | null = counts.defect ? "defect" : counts.concern ? "concern" : counts.unknown ? "unknown" : null;
  const intent = findings.find(isIntentFinding);

  let headline: React.ReactNode;
  let color: string | undefined;
  if (status === "ready" && !aiConfigured && findings.length === 0) {
    headline = <span className="text-muted-foreground">Review is off</span>;
  } else if (running && judged === 0) {
    headline = (
      <span className="flex items-center gap-2 text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        Reviewing{progress?.total ? ` ${progress.completed}/${progress.total}` : "…"}
      </span>
    );
  } else if (worst) {
    color = ASSESSMENT_VISUALS[worst].text;
    headline = `${open} need${open === 1 ? "s" : ""} a look`;
  } else if (judged > 0) {
    color = ASSESSMENT_VISUALS.ok.text;
    headline = judged === 1 ? "Looks right" : `All ${judged} OK`;
  } else if (status === "loading") {
    headline = <span className="text-muted-foreground">Checking…</span>;
  } else {
    headline = <span className="text-muted-foreground">Not reviewed yet</span>;
  }

  const parts = [
    counts.defect && `${counts.defect} defect${counts.defect === 1 ? "" : "s"}`,
    counts.concern && `${counts.concern} concern${counts.concern === 1 ? "" : "s"}`,
    counts.unknown && `${counts.unknown} unknown`,
    counts.fine && `${counts.fine} OK`,
  ].filter(Boolean);

  const intentVerdict: Assessment | null = intent ? (intent.resolvedAt ? "ok" : intent.assessment) : null;

  return (
    <section className="mb-3 border-b border-border pb-3" aria-label="Review verdict">
      <h2
        className="flex items-center gap-2 text-[22px] leading-tight font-semibold tracking-tight"
        style={color ? { color } : undefined}
        title={REVIEW_ADVISORY}
      >
        {headline}
        {running && judged > 0 && (
          <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Still reviewing" />
        )}
        <Spark className="ml-auto self-start" title={REVIEW_ADVISORY} />
      </h2>
      {parts.length > 0 && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{parts.map((part, i) => <span key={String(part)} className="whitespace-nowrap">{i > 0 ? " · " : ""}{part}</span>)}</p>}

      {intent && intentVerdict && (
        <div className="mt-3 text-xs">
          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Delivers what it describes?</p>
          <button
            type="button"
            onClick={() => setShowWhy((v) => !v)}
            aria-expanded={showWhy}
            disabled={!intent.rationale}
            className="mt-1 text-left leading-relaxed disabled:cursor-default"
            title={intent.rationale ? (showWhy ? "Hide the reasoning" : "Show the reasoning") : undefined}
          >
            <span className="font-semibold" style={{ color: ASSESSMENT_VISUALS[intentVerdict].text }}>
              {INTENT_WORDS[intentVerdict]}
            </span>{" "}
            <span className={cn(intent.resolvedAt && "text-muted-foreground")}>{intent.summary}</span>
            {intent.rationale && (
              <ChevronRight
                className={cn("ml-1 inline size-3 align-[-1px] text-muted-foreground transition", showWhy && "rotate-90")}
                aria-hidden
              />
            )}
          </button>
          {showWhy && intent.rationale && (
            <p className="mt-1.5 leading-relaxed whitespace-pre-line text-muted-foreground">{intent.rationale}</p>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {intent.resolvedAt ? "Resolved" : `${formatConfidence(intent.confidence)} sure`}
          </p>
        </div>
      )}
    </section>
  );
}
