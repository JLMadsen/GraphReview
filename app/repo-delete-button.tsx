"use client";

// "Remove" for a repo — on the repo card (landing page) and in the repo
// header. Confirms first, then `DELETE /api/repos/[repoId]`, which drops the
// repo's graph, reviews, chats and (for GitHub/GitLab repos) its clone. A
// local checkout is only read, never deleted — the dialog says so.
//
// Rendered inside the card's stretched link, so clicks stop propagating.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function RepoDeleteButton({
  repoId,
  repoName,
  local,
  redirectTo,
  compact = false,
}: {
  repoId: string;
  repoName: string;
  /** Local repos have no clone to delete; the dialog says the folder stays. */
  local: boolean;
  /** Where to go afterwards (the repo's own pages no longer exist). Omit to just refresh. */
  redirectTo?: string;
  /** Icon-only trigger, for the repo card. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/repos/${repoId}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Request failed with status ${response.status}.`);
      }
      setOpen(false);
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the repo.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (deleting) return;
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size={compact ? "icon-sm" : "sm"}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={`Remove ${repoName}`}
            title={`Remove ${repoName}`}
            onClick={(event) => {
              // Inside the card's stretched link: don't navigate.
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }}
          />
        }
      >
        <Trash2 aria-hidden />
        {compact ? null : "Remove"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md" onClick={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold tracking-tight">Remove {repoName}?</DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            This deletes its component graph, AI reviews and findings, module descriptions and domains, chats and
            checklist answers from GraphReview.{" "}
            {local
              ? "The folder on your disk is not touched."
              : "GraphReview's own clone of it is deleted too; the repository itself is not touched."}{" "}
            You can add it again later, but AI results would have to be generated again.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[13px] text-destructive"
            role="alert"
          >
            <TriangleAlert className="mt-px size-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" disabled={deleting} />}>Cancel</DialogClose>
          <Button type="button" variant="destructive" onClick={() => void remove()} disabled={deleting}>
            {deleting ? <LoaderCircle className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
            {deleting ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
