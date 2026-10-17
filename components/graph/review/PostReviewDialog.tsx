"use client";

// Post review to the PR/MR (DESIGN.md §6.23 §1): pick findings, see where
// each comment lands, edit the summary, pick a verdict, post. Nothing is
// sent until the user clicks Post review — never automatically.

import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, LoaderCircle, Send, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "cn";
import type { PostDraftResponse, PostReviewResponse, PostVerdict } from "@/lib/review-post/types";
import { ASSESSMENT_VISUALS } from "../review-visuals";

const VERDICTS: Array<{ value: PostVerdict; label: string; description: string }> = [
  { value: "comment", label: "Comment", description: "Feedback without approving or blocking." },
  { value: "approve", label: "Approve", description: "Approve the PR along with the comments." },
  { value: "request_changes", label: "Request changes", description: "Ask for changes before it merges." },
];

export function PostReviewDialog({
  repoId,
  prNumber,
  open,
  onClose,
}: {
  repoId: string;
  prNumber: number;
  open: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<PostDraftResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState("");
  const [verdict, setVerdict] = useState<PostVerdict>("comment");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [posted, setPosted] = useState<PostReviewResponse | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDraft(null);
    setLoadError(null);
    setPostError(null);
    fetch(`/api/repos/${encodeURIComponent(repoId)}/review/post?prNumber=${prNumber}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body as PostDraftResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setDraft(body);
        setPicked(new Set(body.items.filter((i) => i.picked).map((i) => i.findingId)));
        setSummary(body.summary);
      })
      .catch((error: Error) => !cancelled && setLoadError(error.message));
    return () => {
      cancelled = true;
    };
  }, [open, repoId, prNumber, nonce]);

  useEffect(() => {
    if (open) {
      setPosted(null);
      setVerdict("comment");
    }
  }, [open]);

  const chosen = useMemo(() => (draft ? draft.items.filter((i) => picked.has(i.findingId)) : []), [draft, picked]);
  const inline = chosen.filter((i) => i.inline).length;
  const host = draft?.host === "gitlab" ? "GitLab" : "GitHub";

  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    if (!draft) return;
    setPosting(true);
    setPostError(null);
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/review/post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prNumber, findingIds: [...picked], summary, verdict, headSha: draft.headSha }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setPosted(body as PostReviewResponse);
      setNonce((n) => n + 1);
    } catch (error) {
      setPostError((error as Error).message);
    } finally {
      setPosting(false);
    }
  };

  const nothingToPost = chosen.length === 0 && !summary.trim() && verdict === "comment";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] w-full max-w-[calc(100%-2rem)] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Send className="size-4 text-brand" aria-hidden />
            Post review to {host} — {draft?.host === "gitlab" ? "MR !" : "PR #"}
            {prNumber}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Nothing is sent until you click Post review. Findings already posted are ticked off with a link.
          </DialogDescription>
        </DialogHeader>

        {!draft && !loadError && (
          <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Checking where each comment would land…
          </p>
        )}
        {loadError && <p className="py-4 text-xs text-destructive">{loadError}</p>}
        {draft?.unavailable && <p className="py-4 text-xs text-destructive">{draft.unavailable}</p>}

        {draft && !draft.unavailable && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto text-xs">
            {draft.reviewedHeadSha && draft.headSha && (
              <p className="flex items-start gap-1.5 rounded-sm border border-border bg-secondary/40 px-2 py-1.5 text-muted-foreground">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                The PR has moved since the review (reviewed at {draft.reviewedHeadSha.slice(0, 7)}, now {draft.headSha.slice(0, 7)}). Lines are checked
                against the current diff; a finding whose line is gone goes into the summary.
              </p>
            )}

            <section aria-label="Findings">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">
                  Findings <span className="text-muted-foreground">· {chosen.length} picked, {inline} inline</span>
                </span>
              </div>
              {draft.items.length === 0 && <p className="text-muted-foreground">No findings with a file location to post — the summary can still go.</p>}
              <ul className="divide-y divide-border rounded-sm border border-border">
                {draft.items.map((item) => {
                  const v = ASSESSMENT_VISUALS[item.assessment];
                  return (
                    <li key={item.findingId} className={cn("flex items-start gap-2 px-2 py-1.5", item.posted && "opacity-70")}>
                      {item.posted ? (
                        <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label="Posted" />
                      ) : (
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={picked.has(item.findingId)}
                          onChange={() => toggle(item.findingId)}
                          aria-label={`Post: ${item.title}`}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium" style={{ color: v.text }}>
                            {v.label}
                          </span>
                          {item.location && <span className="font-mono text-[11px] text-muted-foreground">{item.location}</span>}
                          {item.resolved && <span className="text-[11px] text-muted-foreground">resolved</span>}
                        </div>
                        <p className="truncate" title={item.summary}>
                          {item.summary}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {item.posted ? (
                            <a href={item.posted.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                              Posted {item.posted.postedAt.slice(0, 10)} <ExternalLink className="size-3" aria-hidden />
                            </a>
                          ) : item.inline ? (
                            `Inline on ${item.inline.path}:${item.inline.startLine ? `${item.inline.startLine}-` : ""}${item.inline.line}`
                          ) : (
                            `In the summary — ${item.notInlineReason}`
                          )}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            <label className="flex flex-col gap-1">
              <span className="font-medium">Summary</span>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={6}
                className="rounded-sm border border-border bg-transparent p-2 font-mono text-[12px] outline-none focus-visible:border-brand"
              />
              <span className="text-[11px] text-muted-foreground">
                Picked findings that aren&apos;t on a diff line are listed under it, followed by a line saying it came from GraphReview.
              </span>
            </label>

            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 font-medium">Verdict</legend>
              <div className="flex flex-wrap gap-3">
                {VERDICTS.map((v) => (
                  <label key={v.value} className="flex items-center gap-1.5" title={v.description}>
                    <input type="radio" name="verdict" checked={verdict === v.value} onChange={() => setVerdict(v.value)} />
                    {v.label}
                  </label>
                ))}
              </div>
              {verdict === "request_changes" && draft.requestChangesNote && <span className="text-[11px] text-muted-foreground">{draft.requestChangesNote}</span>}
            </fieldset>

            {draft.reviews.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Posted before:{" "}
                {draft.reviews.map((r, n) => (
                  <a key={n} href={r.url} target="_blank" rel="noreferrer" className="mr-2 underline">
                    {r.postedAt.slice(0, 10)} ({r.verdict.replace("_", " ")}, {r.findings})
                  </a>
                ))}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3 text-xs">
          {postError && <span className="mr-auto text-destructive">{postError}</span>}
          {posted && (
            <a href={posted.url} target="_blank" rel="noreferrer" className="mr-auto inline-flex items-center gap-1 underline">
              Posted — {posted.inline} inline, {posted.inSummary} in the summary <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {posted ? "Close" : "Cancel"}
          </Button>
          {draft && !draft.unavailable && (
            <Button type="button" size="sm" onClick={submit} disabled={posting || nothingToPost}>
              {posting ? <LoaderCircle className="animate-spin" aria-hidden /> : <Send aria-hidden />}
              Post review
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
