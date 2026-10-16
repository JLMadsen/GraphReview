"use client";

// The Files view's directory listing, with the directory's README under it.

import { useMemo } from "react";
import {
  File as FileIcon,
  Folder,
  GitCommitHorizontal,
  LoaderCircle,
} from "lucide-react";
import { cn } from "cn";
import type { LastCommitDTO, RepoTreeResponseDTO } from "../files-types";
import { formatRelativeDate } from "../types";
import { MarkdownDoc } from "./MarkdownDoc";
import { type DirNode, type FileEntry, README, parentOf, collapseChain, formatBytes, isMarkdown } from "./tree";
import { EntryIcon, ChangeMark } from "./TreeLevel";
import { useFileText } from "./useFileText";
import { useLastCommits } from "./useLastCommits";

export function DirectoryPane({
  repoId,
  dirs,
  dir,
  tree,
  showCommit,
  onOpenDir,
  onOpenFile,
  filesByPath,
  changedFiles,
  changedDirs,
}: {
  repoId: string;
  dirs: Map<string, DirNode>;
  dir: string;
  tree: RepoTreeResponseDTO;
  showCommit: boolean;
  onOpenDir: (dir: string) => void;
  onOpenFile: (entry: FileEntry) => void;
  filesByPath: Map<string, FileEntry>;
  changedFiles?: ReadonlySet<string>;
  changedDirs: ReadonlySet<string>;
}) {
  const node = dirs.get(dir)!;
  const readme = node.files.find((f) => README.test(f.name) && !f.added);
  const fileCount = useMemo(() => {
    let n = 0;
    for (const [p, d] of dirs) if (p === dir || p.startsWith(`${dir}/`) || dir === "") n += d.files.length;
    return n;
  }, [dirs, dir]);
  const commits = useLastCommits(repoId, tree.sha, dir);
  // A folder's own latest commit is its row in the folder above.
  const parentCommits = useLastCommits(repoId, tree.sha, dir ? parentOf(dir) : null);
  const dirCommit = dir ? parentCommits?.[dir.slice(dir.lastIndexOf("/") + 1)] : tree.commit && { sha: tree.sha, ...tree.commit };

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {showCommit && (
          <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2 text-[12px]">
            <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            {dirCommit ? (
              <>
                <span className="shrink-0 font-medium text-foreground">{dirCommit.author}</span>
                <span className="min-w-0 truncate text-muted-foreground" title={dirCommit.subject}>
                  {dirCommit.subject}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">{dir && parentCommits === undefined ? "…" : "Analysed commit"}</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <span title={dirCommit?.sha ?? tree.sha}>{(dirCommit?.sha ?? tree.sha).slice(0, 7)}</span>
              {dirCommit?.date && <span title={new Date(dirCommit.date).toLocaleString()}>· {formatRelativeDate(dirCommit.date)}</span>}
              <span>· {fileCount.toLocaleString()} files</span>
            </span>
          </div>
        )}
        <table className="w-full text-[13px]">
          <tbody className="divide-y divide-border">
            {dir && (
              <tr className="hover:bg-secondary/40">
                <td colSpan={4}>
                  <button type="button" onClick={() => onOpenDir(parentOf(dir))} className="flex w-full items-center gap-2 px-3 py-1.5 font-mono text-muted-foreground">
                    <Folder className="size-4 shrink-0 text-brand/70" aria-hidden />
                    ..
                  </button>
                </td>
              </tr>
            )}
            {node.dirs.map((child) => {
              const target = collapseChain(dirs, child);
              return (
                <tr key={child} className="hover:bg-secondary/40">
                  <td>
                    <button type="button" onClick={() => onOpenDir(target)} className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left">
                      <Folder className="size-4 shrink-0 text-brand/70" aria-hidden />
                      <span className="truncate hover:text-brand hover:underline">{target.slice(dir ? dir.length + 1 : 0)}</span>
                      {changedDirs.has(child) && <span className="size-1.5 shrink-0 rounded-full bg-warning" title="Something in here changed" />}
                    </button>
                  </td>
                  <CommitCells commit={commits === undefined ? undefined : (commits?.[child.slice(child.lastIndexOf("/") + 1)] ?? null)} />
                  <td className="w-20 px-3 text-right font-mono text-[11px] text-muted-foreground" />
                </tr>
              );
            })}
            {node.files.map((entry) => (
              <tr key={entry.path} className="hover:bg-secondary/40">
                <td>
                  <button
                    type="button"
                    onClick={() => onOpenFile(entry)}
                    disabled={entry.kind === "submodule"}
                    className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left disabled:cursor-default"
                  >
                    <EntryIcon entry={entry} className="size-4" />
                    <span className={cn("truncate", entry.kind !== "submodule" && "hover:text-brand hover:underline", entry.added && "text-success")}>
                      {entry.name}
                    </span>
                    {entry.kind === "submodule" && <span className="font-mono text-[10px] text-muted-foreground">submodule</span>}
                    <ChangeMark path={entry.path} entry={entry} changedFiles={changedFiles} />
                  </button>
                </td>
                <CommitCells commit={entry.added ? null : commits === undefined ? undefined : (commits?.[entry.name] ?? null)} />
                <td className="w-20 px-3 text-right font-mono text-[11px] whitespace-nowrap text-muted-foreground">{formatBytes(entry.size)}</td>
              </tr>
            ))}
            {node.dirs.length === 0 && node.files.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Nothing here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {readme && <ReadmeCard repoId={repoId} entry={readme} cacheKey={tree.sha} dirs={dirs} filesByPath={filesByPath} onNavigate={onOpenDir} />}
    </>
  );
}

/** A row's newest commit: its subject, then how long ago. `undefined` while the folder's history loads. */
function CommitCells({ commit }: { commit: LastCommitDTO | null | undefined }) {
  return (
    <>
      <td className="hidden max-w-0 px-3 text-[12px] text-muted-foreground md:table-cell md:w-[45%]">
        {commit === undefined ? (
          <span className="block h-2.5 w-2/3 animate-pulse rounded bg-secondary" />
        ) : commit ? (
          <span className="block truncate" title={`${commit.subject}
${commit.author} · ${commit.sha.slice(0, 7)}`}>
            {commit.subject}
          </span>
        ) : null}
      </td>
      <td className="w-28 px-3 text-right text-[11px] whitespace-nowrap text-muted-foreground">
        {commit?.date && <span title={new Date(commit.date).toLocaleString()}>{formatRelativeDate(commit.date)}</span>}
      </td>
    </>
  );
}

export function ReadmeCard({
  repoId,
  entry,
  cacheKey,
  dirs,
  filesByPath,
  onNavigate,
}: {
  repoId: string;
  entry: FileEntry;
  cacheKey: string;
  dirs: Map<string, DirNode>;
  filesByPath: Map<string, FileEntry>;
  onNavigate: (path: string) => void;
}) {
  const state = useFileText(repoId, entry.path, cacheKey);
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <h3 className="flex items-center gap-2 border-b border-border px-4 py-2 text-[12px] font-semibold">
        <FileIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <button type="button" onClick={() => onNavigate(entry.path)} className="hover:text-brand hover:underline">
          {entry.name}
        </button>
      </h3>
      <div className="px-6 py-5">
        {state?.status === "ready" ? (
          isMarkdown(entry.path) ? (
            <MarkdownDoc source={state.data.content} repoId={repoId} sha={cacheKey} dir={parentOf(entry.path)} dirs={dirs} filesByPath={filesByPath} onNavigate={onNavigate} />
          ) : (
            <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{state.data.content}</pre>
          )
        ) : state?.status === "error" ? (
          <p className="text-xs text-muted-foreground">{state.message}</p>
        ) : (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
        )}
      </div>
    </section>
  );
}
