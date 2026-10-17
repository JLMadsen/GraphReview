"use client";

// Export the review (DESIGN.md §6.23 §2–3): the full Markdown report, and the
// change brief (release notes for a ref range), each with Copy and a .md
// download.

import { useCallback, useEffect, useState } from "react";
import { Check, ClipboardCopy, Download, FileText, LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "cn";
import type { ChangeBriefResponse, ReportResponse } from "@/lib/review-post/types";
import { reviewTargetQuery, type ReviewTargetDTO } from "../types";
import { useCopyText } from "./useCopyText";

type ExportTab = "report" | "brief";

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export function ExportDialog({
  repoId,
  target,
  open,
  onClose,
}: {
  repoId: string;
  target: ReviewTargetDTO;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ExportTab>("report");
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [brief, setBrief] = useState<ChangeBriefResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, copyText] = useCopyText();
  const base = `/api/repos/${encodeURIComponent(repoId)}/review`;
  const query = reviewTargetQuery(target);
  const isRange = !("prNumber" in target);
  const briefLabel = isRange ? "Release notes" : "Change brief";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReport(null);
    setBrief(null);
    setError(null);
    // Independent: the report shows as soon as it's built, whatever the brief is doing.
    fetch(`${base}/report?${query}`, { cache: "no-store" })
      .then((r) => readJson<ReportResponse>(r))
      .then((r) => !cancelled && setReport(r))
      .catch((e: Error) => !cancelled && setError(e.message));
    fetch(`${base}/brief?${query}`, { cache: "no-store" })
      .then((r) => readJson<ChangeBriefResponse>(r))
      .then((b) => !cancelled && setBrief(b))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [open, base, query]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const body = "prNumber" in target ? { prNumber: target.prNumber } : { baseRef: target.baseRef, headRef: target.headRef };
      const res = await fetch(`${base}/brief`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setBrief(await readJson<ChangeBriefResponse>(res));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [base, target]);

  const shown = tab === "report" ? report : brief;
  const markdown = shown?.markdown ?? "";
  const filename = shown?.filename ?? "graphreview.md";

  const tabButton = (value: ExportTab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      onClick={() => setTab(value)}
      className={cn(
        "-mb-px border-b-2 px-1 pb-1.5 text-[13px]",
        tab === value ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] w-full max-w-[calc(100%-2rem)] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FileText className="size-4 text-brand" aria-hidden />
            Export review
          </DialogTitle>
          <DialogDescription className="text-xs">Markdown, to paste into a PR, a ticket or a release — or save as a file.</DialogDescription>
        </DialogHeader>

        <div role="tablist" className="flex items-center gap-3 border-b border-border">
          {tabButton("report", "Full report")}
          {tabButton("brief", briefLabel)}
        </div>

        {tab === "brief" && brief && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {brief.source === "ai" ? `Worded by ${brief.model ?? "the model"}, ${brief.generatedAt.slice(0, 16).replace("T", " ")}` : "Built from the review data — no model call."}
            </span>
            {brief.note && <span className="text-foreground/80">{brief.note}</span>}
            {brief.aiConfigured && (
              <Button type="button" variant="outline" size="xs" onClick={generate} disabled={generating} className="ml-auto">
                {generating ? <LoaderCircle className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
                {brief.source === "ai" ? "Write again" : "Write with AI"}
              </Button>
            )}
          </div>
        )}

        <div className="min-h-[12rem] flex-1 overflow-auto rounded-sm border border-border bg-secondary/30">
          {error && <p className="p-3 text-xs text-destructive">{error}</p>}
          {!error && !shown && (
            <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Building…
            </p>
          )}
          {shown && <pre className="p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{markdown}</pre>}
        </div>

        <div className="flex items-center justify-end gap-2 text-xs">
          <Button type="button" variant="outline" size="sm" disabled={!shown} onClick={() => void copyText(markdown)}>
            {copied ? <Check aria-hidden /> : <ClipboardCopy aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button type="button" size="sm" disabled={!shown} onClick={() => download(filename, markdown)}>
            <Download aria-hidden />
            Download .md
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
