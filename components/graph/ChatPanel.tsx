"use client";

// The PR chat column (DESIGN.md §6.7), all the way to the right of the
// Graph tab. Ties the conversation to the graph both ways:
//
// - the component selected in the graph is sent along as the question's
//   focus (a dismissable chip above the input);
// - every component an answer's lookups touched becomes a chip that selects
//   it in the graph, and file paths in an answer open that file's diff.
//
// Answers are rendered from a small Markdown subset (paragraphs, lists,
// headings, code blocks, inline code, bold) — enough for review answers,
// without pulling in a Markdown dependency.

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleStop,
  LoaderCircle,
  MessageSquare,
  Search,
  SendHorizontal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "cn";
import type { ChatMessageDTO, ChatStepDTO } from "./chat-types";
import type { UsePrChatResult } from "./usePrChat";

const SUGGESTIONS = [
  "What does this change do, in plain words?",
  "What else in the codebase could this break?",
  "Is the most serious review finding right?",
];

export interface ChatPanelProps {
  chat: UsePrChatResult;
  /** `null` when nothing reviewable is selected (no PR / refs). */
  targetLabel: string | null;
  focus: { id: string; name: string } | null;
  componentName: (id: string) => string | undefined;
  changedFiles: ReadonlySet<string>;
  onSelectComponent: (id: string) => void;
  onOpenFile?: (path: string) => void;
}

export function ChatPanel({
  chat,
  targetLabel,
  focus,
  componentName,
  changedFiles,
  onSelectComponent,
  onOpenFile,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [useFocus, setUseFocus] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = chat.pending !== null;

  // A new selection is sent along again, even if the last one was dismissed.
  useEffect(() => setUseFocus(true), [focus?.id]);

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
    void chat.send(question, useFocus && focus ? focus.id : undefined);
  };

  const inlineRenderer = (text: string) => renderInline(text, changedFiles, onOpenFile);

  return (
    <div className="flex h-full min-h-[28rem] flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <MessageSquare className="size-4 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tracking-tight">Ask about this change</p>
          <p className="truncate text-[11px] text-muted-foreground">{targetLabel ?? "No PR selected"}</p>
        </div>
        {targetLabel && chat.messages.length > 0 && (
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

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!targetLabel ? (
          <p className="text-xs text-muted-foreground">
            Pick a pull request or compare two refs in the left column, then ask anything about the change — what it
            does, what it could break, whether a finding holds up.
          </p>
        ) : chat.loading ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" /> Loading the conversation…
          </p>
        ) : (
          <>
            {!chat.aiConfigured && (
              <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
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
                  The assistant can read the diff, files at the PR&apos;s head, the component graph and the review&apos;s
                  findings before it answers. Try:
                </p>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    className="block w-full rounded-lg border border-border px-2.5 py-1.5 text-left text-xs text-foreground/90 hover:bg-secondary"
                  >
                    {s}
                  </button>
                ))}
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
                  />
                </Fragment>
              );
            })}
            {chat.pending && (
              <div className="space-y-1">
                {!chat.messages.some((m) => m.role === "user" && m.content === chat.pending!.question) && (
                  <UserBubble text={chat.pending.question} />
                )}
                <Steps steps={chat.pending.steps} open />
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <LoaderCircle className="size-3 animate-spin text-brand" />
                  {chat.pending.steps.length === 0 ? "Thinking…" : "Looking things up…"}
                </p>
              </div>
            )}
            {chat.error && (
              <p className="rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">{chat.error}</p>
            )}
          </>
        )}
      </div>

      {targetLabel && (
        <form
          className="border-t border-border px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
        >
          {focus && useFocus && (
            <p className="mb-1.5 flex items-center gap-1">
              <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] text-foreground">
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
              placeholder={chat.aiConfigured ? "Ask about this change…  (Enter to send)" : "Set up an AI provider first"}
              className="min-h-9 flex-1 resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-brand disabled:opacity-60"
              aria-label="Question"
            />
            {busy ? (
              <button
                type="button"
                onClick={chat.stop}
                className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
                title="Stop"
                aria-label="Stop"
              >
                <CircleStop className="size-4" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!draft.trim() || !chat.aiConfigured}
                className="rounded-lg bg-brand p-2 text-white disabled:opacity-40"
                title="Send"
                aria-label="Send"
              >
                <SendHorizontal className="size-4" />
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[90%] rounded-2xl rounded-br-sm bg-brand/15 px-3 py-1.5 text-xs whitespace-pre-wrap">{text}</p>
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
        <Search className="size-3" />
        {steps.length} lookup{steps.length === 1 ? "" : "s"}
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
}: {
  message: ChatMessageDTO;
  componentName: (id: string) => string | undefined;
  onSelectComponent: (id: string) => void;
  renderInline: (text: string) => ReactNode;
}) {
  if (message.role === "user") return <UserBubble text={message.content} />;
  if (message.error) {
    return <p className="rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">{message.content}</p>;
  }
  const chips = message.componentIds
    .map((id) => ({ id, name: componentName(id) }))
    .filter((c): c is { id: string; name: string } => Boolean(c.name));
  return (
    <div className="space-y-1.5">
      <Steps steps={message.steps} />
      <div className="space-y-1.5 text-xs leading-relaxed">{renderMarkdown(message.content, inline)}</div>
      {chips.length > 0 && (
        <p className="flex flex-wrap gap-1">
          {chips.slice(0, 8).map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => onSelectComponent(chip.id)}
              className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-brand/50 hover:text-foreground"
              title="Select in the graph"
            >
              {chip.name}
            </button>
          ))}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A small Markdown subset
// ---------------------------------------------------------------------------

/** `app/map/page.tsx:12` → `app/map/page.tsx`, when it's a changed file. */
function changedFileOf(code: string, changedFiles: ReadonlySet<string>): string | null {
  const path = code.replace(/:\d+(-\d+)?$/, "");
  return changedFiles.has(path) ? path : null;
}

function renderInline(text: string, changedFiles: ReadonlySet<string>, onOpenFile?: (path: string) => void): ReactNode {
  const parts: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) parts.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      const file = onOpenFile ? changedFileOf(match[1], changedFiles) : null;
      parts.push(
        file ? (
          <button
            key={key++}
            type="button"
            onClick={() => onOpenFile!(file)}
            className="rounded bg-brand/10 px-1 font-mono text-[11px] text-brand hover:underline"
            title="Open this file's diff"
          >
            {match[1]}
          </button>
        ) : (
          <code key={key++} className="rounded bg-secondary px-1 font-mono text-[11px]">
            {match[1]}
          </code>
        )
      );
    } else {
      parts.push(<strong key={key++}>{match[2]}</strong>);
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
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(
        <pre key={key++} className="overflow-x-auto rounded-lg bg-background px-2.5 py-2 font-mono text-[11px] ring-1 ring-border">
          {code.join("\n")}
        </pre>
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
        <p key={key++} className="font-semibold">
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
