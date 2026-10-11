"use client";

// The Files view's left tree: one directory level, its entries and change marks.

import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileCode2,
  FileSymlink,
  Folder,
  FolderGit2,
  FolderOpen,
} from "lucide-react";
import { cn } from "cn";
import { languageForPath } from "../highlight";
import { type FileEntry, type DirNode, nameOf } from "./tree";

export function EntryIcon({ entry, className }: { entry: FileEntry; className?: string }) {
  const Icon = entry.kind === "submodule" ? FolderGit2 : entry.kind === "symlink" ? FileSymlink : languageForPath(entry.path) ? FileCode2 : FileIcon;
  return <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} aria-hidden />;
}

/** "M" for a file the diff changes, "new" for one it adds. */
export function ChangeMark({ path, entry, changedFiles }: { path: string; entry?: FileEntry; changedFiles?: ReadonlySet<string> }) {
  if (entry?.added) return <span className="ml-auto shrink-0 font-mono text-[10px] text-success" title="Added by this diff">new</span>;
  if (!changedFiles?.has(path)) return null;
  return (
    <span className="ml-auto shrink-0 font-mono text-[10px] font-semibold text-warning" title="Changed by this diff">
      M
    </span>
  );
}

export function TreeLevel({
  dirs,
  dir,
  depth,
  current,
  expanded,
  onToggle,
  onOpenDir,
  onOpenFile,
  changedFiles,
  changedDirs,
}: {
  dirs: Map<string, DirNode>;
  dir: string;
  depth: number;
  current: string;
  expanded: ReadonlySet<string>;
  onToggle: (dir: string) => void;
  onOpenDir: (dir: string) => void;
  onOpenFile: (entry: FileEntry) => void;
  changedFiles?: ReadonlySet<string>;
  changedDirs: ReadonlySet<string>;
}) {
  const node = dirs.get(dir);
  if (!node) return null;
  const pad = { paddingLeft: `${8 + depth * 12}px` };
  return (
    <ul>
      {node.dirs.map((child) => {
        const open = expanded.has(child);
        const Chevron = open ? ChevronDown : ChevronRight;
        const FolderIcon = open ? FolderOpen : Folder;
        return (
          <li key={child}>
            <div
              className={cn(
                "flex w-full items-center gap-1 py-[3px] pr-2 text-[12px] hover:bg-secondary/60",
                child === current && "bg-secondary font-medium text-foreground"
              )}
              style={pad}
            >
              <button type="button" onClick={() => onToggle(child)} aria-label={open ? "Collapse" : "Expand"} aria-expanded={open} className="shrink-0 text-muted-foreground hover:text-foreground">
                <Chevron className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => {
                  onOpenDir(child);
                  if (!open) onToggle(child);
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                title={child}
              >
                <FolderIcon className="size-3.5 shrink-0 text-brand/70" aria-hidden />
                <span className="truncate">{nameOf(child)}</span>
                {changedDirs.has(child) && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warning" title="Something in here changed" />}
              </button>
            </div>
            {open && (
              <TreeLevel
                dirs={dirs}
                dir={child}
                depth={depth + 1}
                current={current}
                expanded={expanded}
                onToggle={onToggle}
                onOpenDir={onOpenDir}
                onOpenFile={onOpenFile}
                changedFiles={changedFiles}
                changedDirs={changedDirs}
              />
            )}
          </li>
        );
      })}
      {node.files.map((entry) => (
        <li key={entry.path}>
          <button
            type="button"
            onClick={() => onOpenFile(entry)}
            disabled={entry.kind === "submodule"}
            className={cn(
              "flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[12px] hover:bg-secondary/60 disabled:cursor-default disabled:hover:bg-transparent",
              entry.path === current && "bg-secondary font-medium text-foreground"
            )}
            style={{ paddingLeft: `${8 + depth * 12 + 18}px` }}
            title={entry.path}
          >
            <EntryIcon entry={entry} />
            <span className={cn("truncate", entry.added && "text-success")}>{entry.name}</span>
            <ChangeMark path={entry.path} entry={entry} changedFiles={changedFiles} />
          </button>
        </li>
      ))}
    </ul>
  );
}
