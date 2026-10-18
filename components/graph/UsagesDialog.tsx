"use client";

// Where a function, method or class is used (DESIGN.md §6.28). Every code
// view puts an "N usages" button at the end of a declaration's line
// (`UsagesButton`); it opens this dialog: the declaration's source at the
// top, then each file that uses it with two lines of code around every use,
// the name marked, and a button that opens the file at that use. The usages
// come from `GET /api/repos/[repoId]/code-usages`, read at the commit the
// view shows (lib/jobs/code-usages.ts).

import { Fragment, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, LoaderCircle, TriangleAlert } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "cn";
import { escapeHtml, nameRanges, type CodeDecl, type CodeUsagesResponseDTO, type UsageBlock } from "./code-links";
import { markRanges } from "./diff-model";
import { highlightLines, languageForPath } from "./highlight";

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** The button at the end of a declaration's line. */
export function UsagesButton({ decl, onOpen }: { decl: CodeDecl; onOpen: (decl: CodeDecl) => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(decl);
      }}
      className={cn(
        "usages-button ml-3 inline-flex items-center rounded-sm border px-1 align-[1px] font-sans text-[10px] leading-4 select-none",
        decl.usages === 0
          ? "border-border/50 text-muted-foreground/60 hover:text-muted-foreground"
          : "border-border text-muted-foreground hover:border-brand/60 hover:text-brand"
      )}
      title={`Where ${decl.qualified} is used`}
    >
      {decl.usages === 0 ? "no usages" : plural(decl.usages, "usage")}
    </button>
  );
}

/** Numbered, highlighted lines starting at `from`; the `uses` lines tinted with their names marked. A use's number opens it. */
function CodeLines({
  lines,
  from,
  filePath,
  uses,
  names,
  onLine,
}: {
  lines: readonly string[];
  from: number;
  filePath: string;
  uses?: readonly number[];
  names?: readonly string[];
  onLine?: (line: number) => void;
}) {
  const html = useMemo(() => highlightLines(lines, languageForPath(filePath)), [lines, filePath]);
  const useSet = useMemo(() => new Set(uses ?? []), [uses]);
  return (
    <table className="w-full border-collapse">
      <tbody>
        {lines.map((text, i) => {
          const n = from + i;
          const isUse = useSet.has(n);
          const base = html?.[i] ?? escapeHtml(text || " ");
          const marked = isUse && names ? markRanges(base, nameRanges(text, names), '<mark class="usage-mark">', "</mark>") : base;
          return (
            <tr key={n} className={cn(isUse && "bg-brand/10")}>
              <td
                className={cn(
                  "w-10 shrink-0 border-r border-border/40 px-1.5 text-right align-top font-mono text-[10px] text-muted-foreground select-none",
                  isUse && "border-l-[3px] border-l-brand text-brand",
                  isUse && onLine && "cursor-pointer hover:underline"
                )}
                onClick={isUse && onLine ? () => onLine(n) : undefined}
                title={isUse && onLine ? `Open ${filePath}:${n}` : undefined}
              >
                {n}
              </td>
              <td className="w-full px-2 font-mono text-[12px] leading-relaxed whitespace-pre" dangerouslySetInnerHTML={{ __html: marked }} />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Blocks({ file, blocks, names, onView }: { file: string; blocks: UsageBlock[]; names: string[]; onView: (path: string, line: number, names: string[]) => void }) {
  return (
    <div className="overflow-x-auto">
      {blocks.map((block, i) => (
        <Fragment key={block.from}>
          {i > 0 && <div className="border-y border-dashed border-border/60 bg-muted/30 px-2 text-center font-mono text-[10px] leading-4 text-muted-foreground/60 select-none">⋯</div>}
          <CodeLines lines={block.lines} from={block.from} filePath={file} uses={block.uses} names={names} onLine={(n) => onView(file, n, names)} />
        </Fragment>
      ))}
    </div>
  );
}

type LoadState = { status: "loading" } | { status: "ready"; data: Extract<CodeUsagesResponseDTO, { state: "ready" }> } | { status: "empty"; message: string } | { status: "error"; message: string };

export interface UsagesDialogProps {
  repoId: string;
  /** The declaration whose usages to show, or `null` while closed. */
  decl: CodeDecl | null;
  /** The commit the view shows — a review target's head or merge-base; none: the repo's analysed commit. */
  sha?: string;
  onClose: () => void;
  /** Opens `path` at `line` (a use, or the declaration) in the view the dialog was opened from, `names` marked on that line. */
  onView: (path: string, line: number, names: string[]) => void;
}

export function UsagesDialog({ repoId, decl, sha, onClose, onView }: UsagesDialogProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const id = decl?.id;
  useEffect(() => {
    if (!id) return;
    let live = true;
    setState({ status: "loading" });
    const params = new URLSearchParams({ id });
    if (sha) params.set("sha", sha);
    fetch(`/api/repos/${encodeURIComponent(repoId)}/code-usages?${params}`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as CodeUsagesResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        if (!live) return;
        if (json.state === "ready") setState({ status: "ready", data: json });
        else setState({ status: "empty", message: json.state === "none" ? "This commit was analysed before usages were recorded — re-analyse the repo to see them." : "The declaration isn't in the analysis any more." });
      })
      .catch((err: unknown) => {
        if (live) setState({ status: "error", message: err instanceof Error ? err.message : "Couldn't read the usages." });
      });
    return () => {
      live = false;
    };
  }, [repoId, id, sha]);

  const view = (path: string, line: number, names?: string[]) => {
    onClose();
    onView(path, line, names ?? data?.files.find((f) => f.file === path)?.names ?? (decl ? [decl.qualified.split(".").pop()!] : []));
  };
  const data = state.status === "ready" ? state.data : null;
  const declFile = data?.decl.file ?? (id ? id.slice(0, id.indexOf("#")) : "");

  return (
    <Dialog open={Boolean(decl)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[88vh] w-full max-w-[calc(100%-2rem)] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 pr-8 text-[13px] font-normal">
            <span className="text-muted-foreground">Usages of</span>
            <code className="font-mono font-semibold text-foreground">{decl?.qualified}</code>
            <span className="rounded-sm bg-secondary px-1 font-sans text-[10px] text-muted-foreground">{decl?.kind}</span>
            {data && (
              <span className="ml-auto font-sans text-[11px] text-muted-foreground">
                {plural(data.total, "usage")} in {plural(data.files.length, "file")}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <section className="overflow-hidden rounded-md border border-border">
            <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-2 py-1">
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={declFile}>
                {declFile}:{decl?.line}
              </span>
              {decl && (
                <button
                  type="button"
                  onClick={() => view(declFile, decl.line, [decl.qualified.split(".").pop()!])}
                  className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px] hover:bg-secondary"
                >
                  View source <ArrowUpRight className="size-3" aria-hidden />
                </button>
              )}
            </div>
            {data?.decl.source ? (
              <div className="max-h-72 overflow-auto">
                <CodeLines lines={data.decl.source} from={data.decl.line} filePath={declFile} />
                {data.decl.sourceCut > 0 && <p className="border-t border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground/70 italic">… {plural(data.decl.sourceCut, "more line")}</p>}
              </div>
            ) : (
              <p className="px-2 py-3 text-[11px] text-muted-foreground">{state.status === "loading" ? "Loading…" : data ? "The source couldn't be read." : ""}</p>
            )}
          </section>

          {state.status === "loading" && (
            <p className="flex items-center gap-2 px-1 py-4 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Finding usages…
            </p>
          )}
          {(state.status === "error" || state.status === "empty") && (
            <p className={cn("flex items-start gap-2 px-1 py-4 text-xs", state.status === "error" ? "text-destructive" : "text-muted-foreground")}>
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              {state.message}
            </p>
          )}
          {data && data.files.length === 0 && (
            <p className="px-1 py-4 text-xs text-muted-foreground">
              Nothing in the repo uses it — as far as static analysis sees: calls on instances it can&apos;t type, and uses from outside the repo, aren&apos;t counted.
            </p>
          )}
          {data?.files.map((f) => (
            <section key={f.file} className="overflow-hidden rounded-md border border-border">
              <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-2 py-1">
                <span className="min-w-0 truncate font-mono text-[12px]" title={f.file}>
                  {f.file}
                </span>
                {f.file === declFile && <span className="shrink-0 text-[10px] text-muted-foreground">same file</span>}
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{plural(f.lines.length, "use")}</span>
                <button
                  type="button"
                  onClick={() => view(f.file, f.lines[0])}
                  className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px] hover:bg-secondary"
                  title={`Open ${f.file} at line ${f.lines[0]}`}
                >
                  View file <ArrowUpRight className="size-3" aria-hidden />
                </button>
              </div>
              {f.blocks ? (
                <Blocks file={f.file} blocks={f.blocks} names={f.names} onView={view} />
              ) : (
                <p className="px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                  line{f.lines.length === 1 ? "" : "s"}{" "}
                  {f.lines.map((n, i) => (
                    <Fragment key={n}>
                      {i > 0 && ", "}
                      <button type="button" className="hover:text-foreground hover:underline" onClick={() => view(f.file, n)}>
                        {n}
                      </button>
                    </Fragment>
                  ))}
                </p>
              )}
              {f.moreSites > 0 && f.blocks && (
                <p className="border-t border-border px-2 py-0.5 text-[10px] text-muted-foreground/70 italic">… {plural(f.moreSites, "more use")} — open the file to see them</p>
              )}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
