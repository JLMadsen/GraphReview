"use client";

// "Add repo" dialog for the landing page.
//
// Three ingestion flows behind one dialog: a path under the bind-mounted
// local-repos folder, or a GitHub/GitLab URL the app clones itself
// (into `repo_cache`). All POST to /api/repos, which creates the node and
// immediately queues the first analysis — so on success we just
// refresh the server-rendered list and the new repo shows up as
// "Analyzing…".

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ChevronDown,
  Github,
  Gitlab,
  HardDrive,
  LoaderCircle,
  Plus,
  TriangleAlert,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Mode = "local" | "github" | "gitlab";

interface LocalRepoCandidate {
  name: string;
  path: string;
}

export function AddRepoDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("local");
  const [localPath, setLocalPath] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [candidates, setCandidates] = useState<LocalRepoCandidate[]>([]);
  const [candidatesLoaded, setCandidatesLoaded] = useState(false);

  // Populated from the local-repos root so the user can pick a repo
  // instead of typing its full path — fetched once per time the dialog
  // opens rather than on every keystroke.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCandidatesLoaded(false);
    fetch("/api/local-repos")
      .then((response) => (response.ok ? response.json() : []))
      .then((data: LocalRepoCandidate[]) => {
        if (!cancelled) setCandidates(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setCandidatesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function reset() {
    setLocalPath("");
    setUrl("");
    setName("");
    setError(null);
    setSubmitting(false);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const body =
      mode === "local"
        ? { provider: "local", localPath: localPath.trim(), name: name.trim() || undefined }
        : { provider: mode, url: url.trim(), name: name.trim() || undefined };

    try {
      const response = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(
          (payload as { error?: string } | null)?.error ??
            `Request failed with status ${response.status}.`
        );
        setSubmitting(false);
        return;
      }

      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the server.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button />}>
        <Plus aria-hidden />
        Add repo
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
            <span className="flex size-7 items-center justify-center rounded-lg bg-brand-muted text-brand ring-1 ring-brand/25">
              <Plus className="size-4" />
            </span>
            Add a repository
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            Analysis starts as soon as the repo is added.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <Tabs
            value={mode}
            onValueChange={(value) => {
              setMode(value as Mode);
              setError(null);
            }}
          >
            <TabsList className="w-full ring-1 ring-border/60">
              <TabsTrigger value="local">
                <HardDrive aria-hidden />
                Local path
              </TabsTrigger>
              <TabsTrigger value="github">
                <Github aria-hidden />
                GitHub URL
              </TabsTrigger>
              <TabsTrigger value="gitlab">
                <Gitlab aria-hidden />
                GitLab URL
              </TabsTrigger>
            </TabsList>

            <TabsContent value="local" className="space-y-2 pt-3">
              <label htmlFor="localPath" className="text-[13px] font-medium">
                Path
              </label>
              {candidates.length > 0 ? (
                <div className="relative">
                  <select
                    id="localPathSelect"
                    aria-label="Detected local repos"
                    className="flex h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
                    value={candidates.some((c) => c.path === localPath) ? localPath : ""}
                    onChange={(event) => {
                      if (event.target.value) setLocalPath(event.target.value);
                    }}
                  >
                    <option value="">
                      Select a detected repo…
                    </option>
                    {candidates.map((candidate) => (
                      <option key={candidate.path} value={candidate.path}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                </div>
              ) : null}
              <Input
                className="font-mono"
                id="localPath"
                name="localPath"
                value={localPath}
                onChange={(event) => setLocalPath(event.target.value)}
                placeholder={
                  candidates.length > 0 ? "…or type a path manually" : "my-project"
                }
                autoComplete="off"
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Must be a repo inside the folder mounted at{" "}
                <span className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px] text-foreground/80">
                  LOCAL_REPOS_PATH
                </span>
                . Relative paths resolve from there.
                {candidatesLoaded && candidates.length === 0
                  ? " No git repos were detected directly under that folder — enter the path manually."
                  : null}
              </p>
            </TabsContent>

            <TabsContent value="github" className="space-y-2 pt-3">
              <label htmlFor="url" className="text-[13px] font-medium">
                Repository URL
              </label>
              <Input
                id="url"
                name="url"
                className="font-mono"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                autoComplete="off"
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Cloned and kept up to date by the app. Private repos need a
                GitHub PAT in Settings.
              </p>
            </TabsContent>

            <TabsContent value="gitlab" className="space-y-2 pt-3">
              <label htmlFor="gitlabUrl" className="text-[13px] font-medium">
                Repository URL
              </label>
              <Input
                id="gitlabUrl"
                name="url"
                className="font-mono"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://gitlab.com/group/project"
                autoComplete="off"
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Cloned and kept up to date by the app. Private/self-hosted
                repos need a GitLab PAT in Settings (and{" "}
                <span className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px] text-foreground/80">
                  GITLAB_API_URL
                </span>{" "}
                set for a self-hosted instance).
              </p>
            </TabsContent>
          </Tabs>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="name" className="text-[13px] font-medium">
                Display name
              </label>
              <span className="text-[11px] text-muted-foreground">optional</span>
            </div>
            <Input
              id="name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Defaults to the folder or owner/repo name"
              autoComplete="off"
            />
          </div>

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
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={
                submitting || (mode === "local" ? !localPath.trim() : !url.trim())
              }
            >
              {submitting ? (
                <>
                  <LoaderCircle className="animate-spin" aria-hidden />
                  Adding…
                </>
              ) : (
                "Add repo"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
