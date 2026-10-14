"use client";

// The chat (DESIGN.md §6.7), at the bottom of the Graph tab's right column.
// With a PR or ref comparison selected it is about that change; with none it
// is about the repo itself — how it's put together, where something lives.
// Ties the conversation to the graph both ways:
//
// - the component selected in the graph is sent along as the question's
//   focus (a dismissable chip above the input);
// - every component an answer's lookups touched becomes a chip that selects
//   it in the graph, and file paths in an answer open that file's diff;
// - what an answer put on screen (show, highlight, filter_findings,
//   switch_view, open_diff) is applied when it arrives (GraphView) and stays
//   as a chip that does it again — unless the reviewer has been using the
//   screen since asking, when it is only a chip ("left your screen as it was");
// - what an answer is about (`point_to`) and where to look next (`next`) are
//   chips that move nothing until clicked;
// - what is on screen is sent with each question, and a finding's Ask puts
//   the finding above the input, so the question is about it;
// - a verdict on an existing finding (triage_finding) is a card with Apply /
//   Dismiss, like a suggested finding.
//
// It reads as a chat: questions are bubbles on the right, answers bubbles on
// the left (bold in an answer is dropped — models love bold lead-ins), file
// paths are small file-icon chips, and what the answer looked at goes on one
// quiet line under its bubble.
//
// Answers are rendered from a small Markdown subset (paragraphs, lists,
// headings, code blocks, inline code, bold) — enough for review answers,
// without pulling in a Markdown dependency.

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Crosshair,
  FileDiff,
  FileText,
  Highlighter,
  LayoutGrid,
  Lightbulb,
  ListFilter,
  LoaderCircle,
  MapPin,
  MessageSquare,
  Plus,
  Scale,
  SendHorizontal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "cn";
import type {
  ChatActionDTO,
  ChatMessageDTO,
  ChatStepDTO,
  ChatSuggestionActionDTO,
  ChatSuggestionDTO,
  ChatTriageActionDTO,
  ChatTriageDTO,
} from "./chat-types";
import { AssessmentGlyph } from "./PrMapNode";
import { highlightLines, languageForFence } from "./highlight";
import { startMiddleScroll } from "./middle-scroll";
import type { UsePrChatResult } from "./usePrChat";

const SUGGESTIONS = [
  "What does this change do, in plain words?",
  "What else in the codebase could this break?",
  "Is the most serious review finding right?",
];

const REPO_SUGGESTIONS = [
  "How is this app put together, in a few sentences?",
  "Where would I start to change how reviews are run?",
  "Which parts are most tangled up with each other?",
];

export interface ChatPanelProps {
  chat: UsePrChatResult;
  /** `null` when nothing reviewable is selected (no PR / refs) — the chat is then about the repo. */
  targetLabel: string | null;
  focus: { id: string; name: string } | null;
  componentName: (id: string) => string | undefined;
  changedFiles: ReadonlySet<string>;
  onSelectComponent: (id: string) => void;
  onOpenFile?: (path: string, lines?: string) => void;
  /** Does again what an answer did to the view (or does what it offered). */
  onApplyAction?: (action: ChatActionDTO) => void;
  /** What is on the screen, sent with each question so answers can start from it. */
  screen?: string;
  /** A finding whose Ask was clicked: shown above the input and sent with the question. A new object each time. */
  finding?: { id: string; summary: string; nonce: number } | null;
}

/** The question a finding's Ask starts with. */
const FINDING_QUESTION = "Does this finding hold up?";

export function ChatPanel({
  chat,
  targetLabel,
  focus,
  componentName,
  changedFiles,
  onSelectComponent,
  onOpenFile,
  onApplyAction,
  screen,
  finding,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [useFocus, setUseFocus] = useState(true);
  /** The finding the next question is about, until it is sent or dismissed. */
  const [aboutFinding, setAboutFinding] = useState<{ id: string; summary: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = chat.pending !== null;

  // A new selection is sent along again, even if the last one was dismissed.
  useEffect(() => setUseFocus(true), [focus?.id]);

  // A finding's Ask: it goes above the input, with a question to start from.
  useEffect(() => {
    if (!finding) return;
    setAboutFinding({ id: finding.id, summary: finding.summary });
    setDraft((d) => (d.trim() ? d : FINDING_QUESTION));
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [finding]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages.length, chat.pending?.steps.length, busy]);

  useEffect(() => {
    if (!confirmClear) return;
    const timer = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmClear]);

  const submit = (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setDraft("");
    setAboutFinding(null);
    void chat.send(question, {
      ...(useFocus && focus ? { focusComponentId: focus.id } : {}),
      ...(aboutFinding ? { findingId: aboutFinding.id } : {}),
      ...(screen ? { screen } : {}),
    });
  };

  const inlineRenderer = (text: string) => renderInline(text, changedFiles, onOpenFile);
  const aboutRepo = targetLabel === null;

  return (
    <div className="flex h-full min-h-64 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <p className="min-w-0 flex-1 truncate">
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Chat</span>
          {!aboutRepo && <span className="ml-2 text-[11px] text-muted-foreground">about this change</span>}
        </p>
        <p className="shrink-0 truncate font-mono text-[11px] text-muted-foreground">
          {chat.messages.length > 0
            ? `${chat.messages.filter((m) => m.role === "user").length} asked · `
            : ""}
          {targetLabel ?? "whole repo"}
        </p>
        {chat.messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                return;
              }
              setConfirmClear(false);
              void chat.clear();
            }}
            disabled={busy}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50",
              confirmClear && "text-destructive"
            )}
            title="Delete this conversation"
          >
            <Trash2 className="size-3.5" />
            {confirmClear && "Click again to clear"}
          </button>
        )}
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
      >
        {chat.loading ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" /> Loading the conversation…
          </p>
        ) : (
          <>
            {!chat.aiConfigured && (
              <p className="flex items-start gap-1.5 text-[11px] text-warning">
                <TriangleAlert className="mt-px size-3 shrink-0" />
                <span>
                  The chat needs an AI provider —{" "}
                  <a href="/settings" className="font-medium underline-offset-2 hover:underline">
                    Settings
                  </a>
                  .
                </span>
              </p>
            )}
            {chat.messages.length === 0 && !busy && chat.aiConfigured && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-muted-foreground">
                  {aboutRepo ? (
                    <>Ask anything about the repo. Pick a PR on the left to ask about a change. Try:</>
                  ) : (
                    <>
                      The assistant can read the diff, files at the PR&apos;s head, calls and imports, the history,
                      the checklist, CI and the review&apos;s findings before it answers — and point at what it means
                      on screen. Try:
                    </>
                  )}
                </p>
                <ul className="divide-y divide-border/70 border-y border-border/70">
                  {(aboutRepo ? REPO_SUGGESTIONS : SUGGESTIONS).map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        onClick={() => submit(s)}
                        className="block w-full px-1 py-1.5 text-left text-xs text-foreground/90 hover:bg-secondary"
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {chat.messages.map((message, index) => {
              const previous = chat.messages[index - 1];
              const olderCommit =
                chat.headSha && message.headSha && message.headSha !== chat.headSha && previous?.headSha !== message.headSha;
              return (
                <Fragment key={message.id}>
                  {olderCommit && (
                    <p className="text-center text-[10px] text-muted-foreground">
                      — about an older commit <code className="font-mono">{message.headSha!.slice(0, 7)}</code>; the
                      change has moved on —
                    </p>
                  )}
                  <Message
                    message={message}
                    componentName={componentName}
                    onSelectComponent={onSelectComponent}
                    renderInline={inlineRenderer}
                    onAnswerSuggestion={(id, action) => chat.answerSuggestion(message.id, id, action)}
                    onAnswerTriage={(id, action) => chat.answerTriage(message.id, id, action)}
                    onOpenFile={onOpenFile}
                    onApplyAction={onApplyAction}
                    held={chat.held.has(message.id)}
                  />
                </Fragment>
              );
            })}
            {chat.pending && (
              <div className="space-y-3">
                {!chat.messages.some((m) => m.role === "user" && m.content === chat.pending!.question) && (
                  <UserBubble text={chat.pending.question} />
                )}
                <AssistantBubble footer={<Steps steps={chat.pending.steps} open />}>
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <LoaderCircle className="size-3 animate-spin" />
                    {chat.pending.steps.length === 0 ? "Thinking…" : "Looking things up…"}
                  </p>
                </AssistantBubble>
              </div>
            )}
            {chat.error && (
              <p className="text-[11px] text-destructive">{chat.error}</p>
            )}
          </>
        )}
      </div>

      <form
        className="border-t border-border px-4 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        {aboutFinding && (
          <p className="mb-1.5 flex items-center gap-1">
            <span className="inline-flex max-w-full items-center gap-1 rounded-sm border border-brand/50 px-1.5 py-0.5 text-[11px] text-foreground">
              <MessageSquare className="size-3 shrink-0 text-brand" aria-hidden />
              <span className="shrink-0 text-muted-foreground">Finding</span>
              <span className="truncate font-medium" title={aboutFinding.summary}>
                {aboutFinding.summary}
              </span>
              <button
                type="button"
                onClick={() => setAboutFinding(null)}
                className="rounded-full text-muted-foreground hover:text-foreground"
                aria-label="Don't ask about this finding"
              >
                <X className="size-2.5" />
              </button>
            </span>
          </p>
        )}
        {focus && useFocus && (
          <p className="mb-1.5 flex items-center gap-1">
            <span className="inline-flex max-w-full items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-foreground">
              <span className="text-muted-foreground">About</span>
              <span className="truncate font-medium">{focus.name}</span>
              <button
                type="button"
                onClick={() => setUseFocus(false)}
                className="rounded-full text-muted-foreground hover:text-foreground"
                aria-label="Don't send the selected component"
              >
                <X className="size-2.5" />
              </button>
            </span>
          </p>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            rows={2}
            disabled={!chat.aiConfigured}
            placeholder={
              chat.aiConfigured
                ? `${aboutRepo ? "Ask about the repo" : "Ask about this change"}…  (Enter to send)`
                : "Set up an AI provider first"
            }
            className="min-h-9 flex-1 resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-brand disabled:opacity-60"
            aria-label="Question"
          />
          {busy ? (
            <button
              type="button"
              onClick={chat.stop}
              className="rounded-md border border-border p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="Stop"
              aria-label="Stop"
            >
              <CircleStop className="size-4" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim() || !chat.aiConfigured}
              className="rounded-md bg-primary p-2 text-primary-foreground disabled:opacity-30"
              title="Send"
              aria-label="Send"
            >
              <SendHorizontal className="size-4" />
            </button>
          )}
        </div>
      </form>

    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end pl-8">
      <p className="rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-xs leading-snug whitespace-pre-wrap text-primary-foreground">
        {text}
      </p>
    </div>
  );
}

/** The assistant's side: a bubble on the left, what it looked at under it. */
function AssistantBubble({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 pr-6">
      <div className="max-w-full space-y-1.5 rounded-2xl rounded-bl-sm border border-border bg-secondary/40 px-3 py-2">
        {children}
      </div>
      {footer && <div className="px-1">{footer}</div>}
    </div>
  );
}

function Steps({ steps, open: initiallyOpen = false }: { steps: ChatStepDTO[]; open?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  if (steps.length === 0) return null;
  return (
    <div className="text-[11px] text-muted-foreground">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 hover:text-foreground">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        looked at {steps.length} thing{steps.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul className="mt-1 ml-4 space-y-0.5 border-l border-border pl-2">
          {steps.map((step, i) => (
            <li key={i} className="truncate" title={JSON.stringify(step.args)}>
              {step.summary}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Message({
  message,
  componentName,
  onSelectComponent,
  renderInline: inline,
  onAnswerSuggestion,
  onAnswerTriage,
  onOpenFile,
  onApplyAction,
  held,
}: {
  message: ChatMessageDTO;
  componentName: (id: string) => string | undefined;
  onSelectComponent: (id: string) => void;
  renderInline: (text: string) => ReactNode;
  onAnswerSuggestion: (suggestionId: string, action: ChatSuggestionActionDTO["action"]) => Promise<void>;
  onAnswerTriage: (triageId: string, action: ChatTriageActionDTO["action"]) => Promise<void>;
  onOpenFile?: (path: string, lines?: string) => void;
  onApplyAction?: (action: ChatActionDTO) => void;
  /** Its view changes weren't applied: the reviewer had moved on. */
  held?: boolean;
}) {
  if (message.role === "user") return <UserBubble text={message.content} />;
  if (message.error) {
    return (
      <AssistantBubble>
        <p className="text-[11px] text-destructive">{message.content}</p>
      </AssistantBubble>
    );
  }
  const chips = message.componentIds
    .map((id) => ({ id, name: componentName(id) }))
    .filter((c): c is { id: string; name: string } => Boolean(c.name));
  const actions = message.actions ?? [];
  const done = actions.filter((a) => !a.offer);
  const offers = actions.filter((a) => a.offer && a.next === undefined);
  const next = actions.find((a) => a.offer && a.next !== undefined);
  return (
    <AssistantBubble
      footer={
        (message.steps.length > 0 || chips.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
            <Steps steps={message.steps} />
            {chips.slice(0, 8).map((chip, i) => (
              <span key={chip.id} className="flex items-center gap-1.5">
                {(i > 0 || message.steps.length > 0) && <span aria-hidden>·</span>}
                <button
                  type="button"
                  onClick={() => onSelectComponent(chip.id)}
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  title="Select in the graph"
                >
                  {chip.name}
                </button>
              </span>
            ))}
          </div>
        )
      }
    >
      <div className="space-y-1.5 text-xs leading-relaxed text-foreground/90">{renderMarkdown(message.content, inline)}</div>
      {onApplyAction && held && done.length > 0 && (
        <p className="text-[10px] text-muted-foreground">Left your screen as it was, since you had moved on. The chips below do it.</p>
      )}
      {onApplyAction && (done.length > 0 || offers.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {done.map((action, i) => (
            <ActionChip key={`d${i}`} action={action} onApply={() => onApplyAction(action)} />
          ))}
          {offers.map((action, i) => (
            <ActionChip key={`o${i}`} action={action} onApply={() => onApplyAction(action)} />
          ))}
        </div>
      )}
      {onApplyAction && next && (
        <button
          type="button"
          onClick={() => onApplyAction(next)}
          className="flex w-full items-start gap-1.5 rounded-md border border-brand/40 bg-brand/5 px-2 py-1 text-left text-[11px] hover:bg-brand/10"
          title="Go there"
        >
          <ArrowRight className="mt-px size-3 shrink-0 text-brand" aria-hidden />
          <span className="min-w-0">
            <span className="font-medium text-foreground">Next: {next.label}</span>
            {next.next && <span className="text-muted-foreground"> — {next.next}</span>}
          </span>
        </button>
      )}
      {message.triage?.map((triage) => (
        <TriageCard key={triage.id} triage={triage} onAnswer={(action) => onAnswerTriage(triage.id, action)} />
      ))}
      {message.suggestions?.map((suggestion) => (
        <SuggestionCard
          key={suggestion.id}
          suggestion={suggestion}
          onAnswer={(action) => onAnswerSuggestion(suggestion.id, action)}
          onOpenFile={onOpenFile}
        />
      ))}
    </AssistantBubble>
  );
}

const ACTION_VERB: Record<ChatActionDTO["kind"], string> = { show: "Show", highlight: "Highlight", filter: "List", view: "Open", file: "Open" };
const ACTION_ICON = { show: Crosshair, highlight: Highlighter, filter: ListFilter, view: LayoutGrid, file: FileDiff } as const;

/** What an answer put on screen (a click puts it there again), or only offered, dashed (a click goes there). */
function ActionChip({ action, onApply }: { action: ChatActionDTO; onApply: () => void }) {
  const Icon = action.offer && action.kind === "show" ? MapPin : ACTION_ICON[action.kind];
  return (
    <button
      type="button"
      onClick={onApply}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground",
        action.offer && "border-dashed"
      )}
      title={action.offer ? "Go there" : "Do this again"}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {!action.offer && <span className="shrink-0">{ACTION_VERB[action.kind]}</span>}
      <span className="truncate text-foreground/90">{action.label}</span>
    </button>
  );
}

const TRIAGE_TITLE: Record<ChatTriageDTO["verdict"], string> = { holds: "Finding holds", wrong: "Finding doesn't hold", rerate: "Re-rate finding" };
const TRIAGE_APPLY: Record<ChatTriageDTO["verdict"], string> = { holds: "Note on finding", wrong: "Resolve finding", rerate: "Change verdict" };

/**
 * The chat's verdict on a finding already in the review. Nothing changes
 * until Apply: a confirming reply, a resolving one, or the new verdict.
 */
function TriageCard({ triage, onAnswer }: { triage: ChatTriageDTO; onAnswer: (action: ChatTriageActionDTO["action"]) => Promise<void> }) {
  const [working, setWorking] = useState<ChatTriageActionDTO["action"] | null>(null);
  const answer = (action: ChatTriageActionDTO["action"]) => {
    setWorking(action);
    void onAnswer(action).finally(() => setWorking(null));
  };
  return (
    <div className={cn("rounded-md border border-dashed border-border px-2.5 py-2", triage.status === "dismissed" && "opacity-60")}>
      <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        <Scale className="size-3" aria-hidden />
        {TRIAGE_TITLE[triage.verdict]}
        <span className="ml-auto flex items-center gap-1 normal-case tracking-normal">
          <AssessmentGlyph intent={triage.from} />
          {triage.from}
          {triage.verdict === "rerate" && triage.assessment && (
            <>
              <ArrowRight className="size-3" aria-hidden />
              <AssessmentGlyph intent={triage.assessment} />
              {triage.assessment}
            </>
          )}
        </span>
      </p>
      <p className="mt-1 text-xs leading-snug font-medium">{triage.findingSummary}</p>
      <p className="mt-0.5 text-[11px] leading-snug whitespace-pre-line text-muted-foreground">{triage.reason}</p>
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
        {triage.status === "pending" ? (
          <>
            <button
              type="button"
              onClick={() => answer("apply")}
              disabled={working !== null}
              className="flex items-center gap-1 rounded-sm bg-primary px-2 py-0.5 font-medium text-primary-foreground disabled:opacity-50"
            >
              {working === "apply" ? <LoaderCircle className="size-3 animate-spin" /> : <Check className="size-3" />}
              {TRIAGE_APPLY[triage.verdict]}
            </button>
            <button
              type="button"
              onClick={() => answer("dismiss")}
              disabled={working !== null}
              className="rounded-sm px-2 py-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              Dismiss
            </button>
          </>
        ) : triage.status === "applied" ? (
          <span className="flex items-center gap-1 text-success">
            <Check className="size-3" /> Applied to the finding
          </span>
        ) : (
          <>
            <span className="text-muted-foreground">Dismissed</span>
            <button
              type="button"
              onClick={() => answer("apply")}
              disabled={working !== null}
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            >
              apply anyway
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A finding the chat noticed without being asked. Nothing reaches the review
 * until Add; once answered the card stays, saying what was decided.
 */
function SuggestionCard({
  suggestion,
  onAnswer,
  onOpenFile,
}: {
  suggestion: ChatSuggestionDTO;
  onAnswer: (action: ChatSuggestionActionDTO["action"]) => Promise<void>;
  onOpenFile?: (path: string, lines?: string) => void;
}) {
  const [working, setWorking] = useState<ChatSuggestionActionDTO["action"] | null>(null);
  const [open, setOpen] = useState(false);
  const answer = (action: ChatSuggestionActionDTO["action"]) => {
    setWorking(action);
    void onAnswer(action).finally(() => setWorking(null));
  };
  const where = suggestion.filePath ? `${suggestion.filePath}${suggestion.line ? `:${suggestion.line}` : ""}` : null;
  const dismissed = suggestion.status === "dismissed";
  return (
    <div className={cn("rounded-md border border-dashed border-border px-2.5 py-2", dismissed && "opacity-60")}>
      <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        <Lightbulb className="size-3" aria-hidden />
        Suggested finding
        <span className="ml-auto flex items-center gap-1 normal-case tracking-normal">
          <AssessmentGlyph intent={suggestion.assessment} />
          {suggestion.assessment}
        </span>
      </p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-1 block w-full text-left text-xs leading-snug font-medium hover:underline"
        title={open ? "Hide the reasoning" : "Show the reasoning"}
      >
        {suggestion.summary}
      </button>
      {where && (
        <button
          type="button"
          disabled={!onOpenFile}
          onClick={() => onOpenFile?.(suggestion.filePath!, suggestion.line ? String(suggestion.line) : undefined)}
          className="mt-0.5 block max-w-full truncate font-mono text-[11px] text-muted-foreground enabled:hover:text-foreground enabled:hover:underline"
        >
          {where}
        </button>
      )}
      {open && <p className="mt-1 text-[11px] leading-snug whitespace-pre-line text-muted-foreground">{suggestion.rationale}</p>}
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
        {suggestion.status === "pending" ? (
          <>
            <button
              type="button"
              onClick={() => answer("add")}
              disabled={working !== null}
              className="flex items-center gap-1 rounded-sm bg-primary px-2 py-0.5 font-medium text-primary-foreground disabled:opacity-50"
            >
              {working === "add" ? <LoaderCircle className="size-3 animate-spin" /> : <Plus className="size-3" />}
              Add to review
            </button>
            <button
              type="button"
              onClick={() => answer("dismiss")}
              disabled={working !== null}
              className="rounded-sm px-2 py-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              Dismiss
            </button>
          </>
        ) : suggestion.status === "added" ? (
          <span className="flex items-center gap-1 text-success">
            <Check className="size-3" /> Added to the review
          </span>
        ) : (
          <>
            <span className="text-muted-foreground">Dismissed</span>
            <button
              type="button"
              onClick={() => answer("add")}
              disabled={working !== null}
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            >
              add anyway
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A small Markdown subset
// ---------------------------------------------------------------------------

/** A relative path with a folder and an extension — `lib/jobs/queue.ts`, `app/[id]/page.tsx`. */
const PATH_LIKE = /^(?!\/)(?!https?:)[\w@.+\-[\]()]+(\/[\w@.+\-[\]()]+)+\.[A-Za-z0-9]{1,10}$/;

/**
 * `app/map/page.tsx:12` → `app/map/page.tsx`: a file the answer names, when
 * it is one of the diff's files or reads like a path in the repo. The viewer
 * says so if a path-like one turns out not to exist.
 */
function fileOf(code: string, changedFiles: ReadonlySet<string>): string | null {
  const path = code.replace(LINES_SUFFIX, "");
  if (changedFiles.has(path) || PATH_LIKE.test(path)) return path;
  // A bare name (`usePrChat.ts`) is the diff's file when exactly one has it.
  if (!path.includes("/") && /\.[A-Za-z0-9]{1,10}$/.test(path)) {
    const matches = [...changedFiles].filter((file) => file.endsWith(`/${path}`) || file === path);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

/** `:12`, `:305-350`, `:305–350`, `#L305-L350` after a path. */
const LINES_SUFFIX = /(?::|#L)(\d+)(?:\s*[-–]\s*L?(\d+))?$/;

/** The lines a citation names, as `"305-350"` or `"12"`. */
function linesOf(code: string): string | undefined {
  const match = LINES_SUFFIX.exec(code);
  if (!match) return undefined;
  return match[2] ? `${match[1]}-${match[2]}` : match[1];
}

/** A file the answer names: a small file icon and its name, the full path on hover. */
function FileChip({ code, file, onOpen }: { code: string; file: string; onOpen: (path: string, lines?: string) => void }) {
  const line = linesOf(code);
  const name = file.slice(file.lastIndexOf("/") + 1);
  return (
    <button
      type="button"
      onClick={() => onOpen(file, line)}
      className="mx-px inline-flex max-w-full items-baseline gap-0.5 rounded px-0.5 align-baseline font-mono text-[11px] text-foreground hover:bg-muted"
      title={`Open ${file}${line ? `:${line}` : ""}`}
    >
      <FileText className="size-3 shrink-0 self-center text-muted-foreground" aria-hidden />
      <span className="truncate">{name}</span>
      {line && <span className="text-muted-foreground">:{line}</span>}
    </button>
  );
}

function renderInline(text: string, changedFiles: ReadonlySet<string>, onOpenFile?: (path: string, lines?: string) => void): ReactNode {
  const parts: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*(.+?)\*\*/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) parts.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      const file = onOpenFile ? fileOf(match[1], changedFiles) : null;
      parts.push(
        file ? (
          <FileChip key={key++} code={match[1]} file={file} onOpen={onOpenFile!} />
        ) : (
          <code key={key++} className="font-mono text-[11px] text-foreground">
            {match[1]}
          </code>
        )
      );
    } else {
      // Bold is dropped on purpose: answers read as prose, not slide bullets.
      // Its inside still gets inline code and file chips.
      parts.push(<Fragment key={key++}>{renderInline(match[2], changedFiles, onOpenFile)}</Fragment>);
    }
    last = match.index! + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function renderMarkdown(source: string, inline: (text: string) => ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const language = languageForFence(line.trim().slice(3));
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      const html = highlightLines(code, language);
      const className = "overflow-x-auto rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11px]";
      out.push(
        html ? (
          // highlight.js output: the code, escaped, inside its token spans.
          <pre key={key++} className={className} onMouseDown={startMiddleScroll} dangerouslySetInnerHTML={{ __html: html.join("\n") }} />
        ) : (
          <pre key={key++} className={className} onMouseDown={startMiddleScroll}>
            {code.join("\n")}
          </pre>
        )
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key++} className={cn("space-y-0.5 pl-4", ordered ? "list-decimal" : "list-disc")}>
          {items.map((item, n) => (
            <li key={n}>{inline(item)}</li>
          ))}
        </List>
      );
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        <p key={key++} className="font-medium">
          {inline(heading[1])}
        </p>
      );
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("```") &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i])
    ) {
      paragraph.push(lines[i++]);
    }
    out.push(<p key={key++}>{inline(paragraph.join(" "))}</p>);
  }
  return out;
}
