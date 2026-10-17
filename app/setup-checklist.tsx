import Link from "next/link";
import { ArrowRight, CircleCheck, CircleDashed, ListChecks } from "lucide-react";
import { cn } from "cn";
import { AddRepoDialog } from "./add-repo-dialog";
import type { SetupStatus } from "./setup-status";

/**
 * The landing page's setup checklist (DESIGN.md §6.25): add a repo, set up
 * an AI provider, and optionally a GitHub/GitLab PAT. Each step says
 * whether it's done and links straight to where it's done. Open until the
 * two required steps are done, then folded to one line (a <details>, so it
 * needs no client code and can still be reopened).
 */
export function SetupChecklist({ hasRepo, status }: { hasRepo: boolean; status: SetupStatus }) {
  const pat = status.githubPat || status.gitlabPat;
  const requiredDone = hasRepo && status.aiConfigured;
  const steps: Array<{ done: boolean; optional?: boolean; title: string; body: React.ReactNode; action: React.ReactNode }> = [
    {
      done: hasRepo,
      title: "Add a repo",
      body: "A folder on this machine, or a GitHub or GitLab URL. Analysis starts as soon as it's added.",
      action: hasRepo ? null : <AddRepoDialog size="sm" variant="outline" />,
    },
    {
      done: status.aiConfigured,
      title: "Set up an AI provider",
      body: (
        <>
          Any OpenAI-compatible endpoint: a base URL, a key and a model. <strong className="font-medium text-foreground/85">Use local config</strong> there
          imports one from OpenCode, Codex, Claude Code and other tools already set up on this machine. Without one, the
          graph and views work but reviews, labels and the chat are off.
        </>
      ),
      action: <StepLink href="/settings#ai-providers">AI providers</StepLink>,
    },
    {
      done: pat,
      optional: true,
      title: "Add a GitHub or GitLab token",
      body: "Only needed to review pull requests or merge requests, and to clone private repos. Local branches compare without one.",
      action: <StepLink href="/settings#git-hosts">Git hosts</StepLink>,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <details open={!requiredDone} className="group/setup mb-6 rounded-xl bg-card ring-1 ring-border">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-xl px-4 py-3 text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
        <ListChecks className="size-4 text-brand" aria-hidden />
        <span className="font-semibold tracking-tight">{requiredDone ? "Set up" : "Get started"}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {doneCount}/{steps.length}
        </span>
        {requiredDone ? <span className="text-xs text-muted-foreground">Ready to review{pat ? "" : " · token optional"}</span> : null}
        <span className="ml-auto text-xs text-muted-foreground group-open/setup:hidden">Show</span>
        <span className="ml-auto hidden text-xs text-muted-foreground group-open/setup:inline">Hide</span>
      </summary>
      <ol className="space-y-px border-t border-border">
        {steps.map((step) => {
          const Icon = step.done ? CircleCheck : CircleDashed;
          return (
            <li key={step.title} className="flex items-start gap-3 px-4 py-3">
              <Icon className={cn("mt-0.5 size-4 shrink-0", step.done ? "text-success" : "text-muted-foreground/60")} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium", step.done && "text-muted-foreground")}>
                  {step.title}
                  {step.optional ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">optional</span> : null}
                  <span className="sr-only">{step.done ? " (done)" : " (not done)"}</span>
                </p>
                {step.done ? null : <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{step.body}</p>}
              </div>
              {step.action ? <div className="shrink-0">{step.action}</div> : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function StepLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand transition-colors hover:bg-brand-muted"
    >
      {children}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}
