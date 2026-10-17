"use client";

// The review dock's Files tab: the diff's changed files, biggest change
// first, with their area (or component), churn and open findings.

import { useMemo } from "react";
import { BookOpen } from "lucide-react";
import { cn } from "cn";
import { STATUS_BADGES } from "../PrMapNode";
import { ASSESSMENT_VISUALS } from "../review-visuals";
import type { PrMapFileDTO, PrMapResponseDTO } from "../pr-map-types";
import type { FindingDTO } from "../types";

const NUMBER = new Intl.NumberFormat("en-US");

export type ChangedFile = PrMapFileDTO & { areaId: string; areaName: string };

/** The map's changed files within the dock's scope (an area, a component), biggest change first. */
export function useChangedFiles(map: PrMapResponseDTO | null, scopeAreaId: string | null, scopeComponentId: string | null): ChangedFile[] {
  return useMemo(() => {
    if (!map) return [];
    const list: ChangedFile[] = [];
    for (const node of map.nodes) {
      if (node.role === "context" || (scopeAreaId && node.id !== scopeAreaId)) continue;
      for (const file of node.files) {
        if (scopeComponentId && file.componentId !== scopeComponentId) continue;
        list.push({ ...file, areaId: node.id, areaName: node.name });
      }
    }
    return list.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path));
  }, [map, scopeAreaId, scopeComponentId]);
}

export function ReviewFilesTab({
  files,
  findings,
  mapLoaded,
  scopeAreaId,
  scopeParts,
  componentName,
  onOpenFile,
  onReadAll,
}: {
  files: ChangedFile[];
  findings: FindingDTO[];
  mapLoaded: boolean;
  scopeAreaId: string | null;
  /** The scope's names ("Area › Component"), for the empty state. */
  scopeParts: string[];
  componentName: (id: string) => string | undefined;
  onOpenFile?: (path: string) => void;
  /** Opens every file's diff in the all-files reader. */
  onReadAll?: () => void;
}) {
  const flagsByFile = useMemo(() => {
    const flags = new Map<string, { open: number; defect: boolean }>();
    for (const f of findings) {
      if (!f.filePath || f.resolvedAt || (f.assessment !== "defect" && f.assessment !== "concern")) continue;
      const prev = flags.get(f.filePath) ?? { open: 0, defect: false };
      flags.set(f.filePath, { open: prev.open + 1, defect: prev.defect || f.assessment === "defect" });
    }
    return flags;
  }, [findings]);
  const maxChurn = Math.max(1, ...files.map((f) => f.additions + f.deletions));

  if (files.length === 0) {
    return (
      <p className="px-2 py-4 text-xs text-muted-foreground">
        {mapLoaded ? (scopeParts.length > 0 ? `No changed files in ${scopeParts.join(" › ")}.` : "No changed files.") : "Loading the files…"}
      </p>
    );
  }
  return (
    <>
      {onReadAll && (
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
          <span>
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={onReadAll}
            className="inline-flex h-6 items-center gap-1 rounded-sm border border-border px-2 text-[11px] text-foreground transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            title="Every file's diff in one scrolling view, with a Viewed checkbox per file (J / K to move)"
          >
            <BookOpen className="size-3" aria-hidden />
            Read all diffs
          </button>
        </div>
      )}
      <div className="sticky top-0 z-10 grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-3 border-b border-border bg-card px-2 py-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase @2xl:grid-cols-[16px_minmax(0,1fr)_140px_56px_56px_96px_32px]">
        <span />
        <span>Path</span>
        <span className="hidden @2xl:block">{scopeAreaId ? "Component" : "Area"}</span>
        <span className="hidden text-right @2xl:block">Added</span>
        <span className="hidden text-right @2xl:block">Removed</span>
        <span className="hidden @2xl:block" />
        <span className="text-right">Open</span>
      </div>
      <ul>
        {files.map((file) => {
          const badge = STATUS_BADGES[file.status] ?? STATUS_BADGES.changed;
          const slash = file.path.lastIndexOf("/");
          const flag = flagsByFile.get(file.path);
          const owner = file.componentId ? (componentName(file.componentId) ?? "") : "";
          const row = (
            <>
              <span className={cn("font-mono text-[11px] font-semibold", badge.className)} title={badge.label}>
                {badge.letter}
              </span>
              <span className="min-w-0 truncate font-mono text-[12px]" title={file.path}>
                <span className="text-muted-foreground">{slash >= 0 ? file.path.slice(0, slash + 1) : ""}</span>
                {slash >= 0 ? file.path.slice(slash + 1) : file.path}
              </span>
              <span className="hidden truncate text-[11px] text-muted-foreground @2xl:block">
                {scopeAreaId ? owner : file.areaName}
              </span>
              <span className="hidden text-right font-mono text-[11px] text-success @2xl:block">
                {file.additions > 0 ? `+${NUMBER.format(file.additions)}` : ""}
              </span>
              <span className="hidden text-right font-mono text-[11px] text-destructive @2xl:block">
                {file.deletions > 0 ? `−${NUMBER.format(file.deletions)}` : ""}
              </span>
              <span className="hidden h-1.5 items-center gap-px @2xl:flex" aria-hidden>
                <span className="h-full rounded-[1px] bg-success" style={{ width: `${(file.additions / maxChurn) * 100}%` }} />
                <span className="h-full rounded-[1px] bg-destructive" style={{ width: `${(file.deletions / maxChurn) * 100}%` }} />
              </span>
              <span className="text-right">
                {flag && (
                  <span
                    className="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold text-background"
                    style={{ background: ASSESSMENT_VISUALS[flag.defect ? "defect" : "concern"].color }}
                    title={`${flag.open} open finding${flag.open === 1 ? "" : "s"} in this file`}
                  >
                    {flag.open}
                  </span>
                )}
              </span>
            </>
          );
          const grid =
            "grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border/70 px-2 py-1.5 text-left @2xl:grid-cols-[16px_minmax(0,1fr)_140px_56px_56px_96px_32px]";
          return (
            <li key={file.path}>
              {onOpenFile ? (
                <button
                  type="button"
                  onClick={() => onOpenFile(file.path)}
                  className={cn(grid, "transition-colors hover:bg-secondary/60")}
                  title={`${file.path} — view diff`}
                >
                  {row}
                </button>
              ) : (
                <div className={grid}>{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
