"use client";

// One card of the PR map (DESIGN.md §6.4): an *area* of the change — its
// name, a short description, how many files and lines it holds, and the number of findings that
// still need a look as a badge in the corner. The files themselves live in the area inspector and the dock's
// Files tab; the card stays small so a map of a dozen areas reads at a
// glance. An area the diff adds whole glows faintly green and says "new"; one
// it deletes whole glows faintly red and says "deleted"; mixed areas stay
// neutral. Rendered twice per layout — once offscreen by `CardFlow` to measure
// its height for ELK, and once as the React Flow node — so it takes plain
// props and knows nothing about React Flow itself.

import { cn } from "cn";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import { areaLifecycle, type AreaLifecycle, type FindingBucket, type PrArea } from "./pr-areas";
import type { PrMapNodeDTO, PrMapRole } from "./pr-map-types";
import type { FileDiffStatus, Assessment } from "./types";

/** Fixed card width — ELK only has to discover heights. */
export const PR_CARD_WIDTH = 216;

const NUMBER = new Intl.NumberFormat("en-US");

const ROLE_TAGS: Partial<Record<PrMapRole, string>> = {
  test: "Tests",
  dependency: "Dependency",
  config: "Config",
  docs: "Docs",
  context: "Unchanged",
};

/** A changed file's status as one coloured letter — shared by the dock's Files tab and the area inspector. */
export const STATUS_BADGES: Record<FileDiffStatus, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "text-success", label: "Added" },
  removed: { letter: "D", className: "text-destructive", label: "Deleted" },
  modified: { letter: "M", className: "text-warning", label: "Modified" },
  renamed: { letter: "R", className: "text-info", label: "Renamed" },
  copied: { letter: "C", className: "text-info", label: "Copied" },
  changed: { letter: "M", className: "text-warning", label: "Changed" },
  unchanged: { letter: "·", className: "text-muted-foreground", label: "Unchanged" },
};

export interface PrCardMarker {
  worst: Assessment;
  count: number;
}

/** A card's worst review verdict and finding count — shared by the PR map and the app map. Glyph + count, no pill: status is loud colour on a quiet card. */
export function CardMarkerBadge({ marker, className }: { marker: PrCardMarker; className?: string }) {
  const visual = ASSESSMENT_VISUALS[marker.worst];
  const Icon = visual.icon;
  return (
    <span
      className={cn("flex shrink-0 items-center gap-0.5 font-mono text-[11px] font-medium", className)}
      style={{ color: visual.text }}
      title={`${visual.label} — ${marker.count} finding${marker.count === 1 ? "" : "s"}`}
    >
      <Icon className="size-[1.1em]" />
      {marker.count}
    </span>
  );
}

/** A file's worst verdict as its glyph in the verdict colour — the file-row counterpart of `CardMarkerBadge`. */
export function AssessmentGlyph({ intent }: { intent: Assessment }) {
  const visual = ASSESSMENT_VISUALS[intent];
  const Icon = visual.icon;
  return (
    <span className="shrink-0" style={{ color: visual.text }} title={`Worst finding: ${visual.label}`}>
      <Icon className="size-3" />
    </span>
  );
}

const COUNT_ITEMS: Array<{ bucket: FindingBucket; label: string; visual: (typeof ASSESSMENT_VISUALS)[keyof typeof ASSESSMENT_VISUALS]; quiet?: boolean }> = [
  { bucket: "defect", label: "defect", visual: ASSESSMENT_VISUALS.defect },
  { bucket: "concern", label: "concern", visual: ASSESSMENT_VISUALS.concern },
  { bucket: "unknown", label: "unknown", visual: ASSESSMENT_VISUALS.unknown, quiet: true },
  { bucket: "fine", label: "OK or resolved", visual: ASSESSMENT_VISUALS.ok, quiet: true },
];

/**
 * An area's findings as a row of glyph + count per bucket — "✕ 5  ▲ 1  ✓ 3"
 * — worst first, empty buckets left out. Same glyphs and colours as the
 * dock's chips; OK and unknown are quieter so problems lead.
 */
export function FindingCounts({ counts, className }: { counts: Record<FindingBucket, number>; className?: string }) {
  const shown = COUNT_ITEMS.filter((item) => counts[item.bucket] > 0);
  if (shown.length === 0) return null;
  return (
    <span
      className={cn("inline-flex items-center gap-2 font-mono text-[11px] tabular-nums", className)}
      title={shown.map((item) => `${counts[item.bucket]} ${item.label}`).join(" · ")}
    >
      {shown.map(({ bucket, visual, quiet }) => {
        const Icon = visual.icon;
        return (
          <span key={bucket} className={cn("inline-flex items-center gap-0.5", quiet && "opacity-70")} style={{ color: visual.text }}>
            <Icon className="size-3" aria-hidden />
            {counts[bucket]}
          </span>
        );
      })}
    </span>
  );
}

/** How many findings in an area still need a look, as a round badge in the defect or concern colour. */
export function OpenBadge({ area, className }: { area: PrArea; className?: string }) {
  if (area.open === 0) return null;
  const worst = area.counts.defect > 0 ? "defect" : "concern";
  return (
    <span
      className={cn(
        "amc-status inline-flex h-[1.8em] min-w-[1.8em] items-center justify-center rounded-full px-[0.45em] font-mono text-[11px] font-semibold text-background",
        className
      )}
      style={{ background: ASSESSMENT_VISUALS[worst].color }}
      title={`${area.counts.defect} defect${area.counts.defect === 1 ? "" : "s"}, ${area.counts.concern} concern${area.counts.concern === 1 ? "" : "s"} still open`}
    >
      {area.open}
    </span>
  );
}

/**
 * The new/deleted look: a hairline of the colour and a soft glow around the
 * card. Kept faint on purpose — it says what the area is, and the review's
 * badge and bar (what needs a look) must stay the loudest thing on a card.
 */
export const LIFECYCLE_STYLES: Record<AreaLifecycle, { card: string; word: string; text: string; title: string }> = {
  new: {
    card: "border-success/45 shadow-[0_0_0_1px_color-mix(in_oklab,var(--success)_22%,transparent),0_0_18px_-2px_color-mix(in_oklab,var(--success)_45%,transparent)]",
    word: "new",
    text: "text-success",
    title: "Every file in this area is new in this diff",
  },
  deleted: {
    card: "border-destructive/45 shadow-[0_0_0_1px_color-mix(in_oklab,var(--destructive)_22%,transparent),0_0_18px_-2px_color-mix(in_oklab,var(--destructive)_45%,transparent)]",
    word: "deleted",
    text: "text-destructive",
    title: "Every file in this area is deleted by this diff",
  },
};

export interface PrMapCardProps {
  node: PrMapNodeDTO;
  /** The card's files, lines and findings — absent while the review hasn't produced any. */
  area?: PrArea;
  selected?: boolean;
  /** Another card is selected: this one steps back. */
  dimmed?: boolean;
  /** Endpoints this area's change touches (handlers in it, or reached code in it). */
  endpoints?: number;
}

export function PrMapCard({ node, area, selected, dimmed, endpoints }: PrMapCardProps) {
  const context = node.role === "context";
  const tag = ROLE_TAGS[node.role];
  const files = node.files.length;
  const lifecycle = areaLifecycle(node);
  const look = lifecycle ? LIFECYCLE_STYLES[lifecycle] : null;
  return (
    <div
      style={{ width: PR_CARD_WIDTH }}
      title={look?.title}
      className={cn(
        "relative rounded-md border px-3 pt-2.5 pb-2.5 text-left transition-[opacity,border-color,box-shadow]",
        context
          ? "border-dashed border-border bg-card/40"
          : look
            ? cn("bg-card", look.card)
            : area && area.open > 0
              ? "border-foreground/25 bg-card"
              : "border-foreground/14 bg-card",
        context && !selected && "opacity-75",
        selected && "border-brand opacity-100 shadow-[0_0_0_4px_color-mix(in_oklab,var(--brand)_18%,transparent)]",
        dimmed && !selected && "opacity-50"
      )}
    >
      {tag && <p className="amc-desc mb-0.5 font-mono text-[10px] text-muted-foreground lowercase">{tag}</p>}
      <p className="amc-name pr-4 text-[13px] leading-snug font-medium">{node.name}</p>
      {/* What the area does, clamped so a long one can't stretch the card; the
          inspector shows it whole. Hidden when zoomed far out, like the tag. */}
      {node.description && (
        <p className="amc-desc mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground" title={node.description}>
          {node.description}
        </p>
      )}
      {/* Unbreakable chunks — "new", "5 files", "+1,160 −83" — so the line can wrap
          between them but never splits a number from its sign; zoomed out,
          the file count steps aside (amc-count) to leave the line counts room. */}
      <p className="amc-status mt-0.5 flex flex-wrap gap-x-2 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
        {context ? (
          "not changed"
        ) : (
          <>
            {look && <span className={cn("font-sans font-medium", look.text)}>{look.word}</span>}
            <span className="amc-count">
              {files} file{files === 1 ? "" : "s"}
            </span>
            {area && (area.additions > 0 || area.deletions > 0) && (
              <span>
                {area.additions > 0 && <span className="text-success">+{NUMBER.format(area.additions)}</span>}
                {area.additions > 0 && area.deletions > 0 && " "}
                {area.deletions > 0 && <span className="text-destructive">−{NUMBER.format(area.deletions)}</span>}
              </span>
            )}
            {endpoints ? (
              <span className="text-info" title={`${endpoints} endpoint${endpoints === 1 ? "" : "s"} touched here (handler or code it reaches)`}>
                ⇄{endpoints}
              </span>
            ) : null}
          </>
        )}
      </p>
      {area && <OpenBadge area={area} className="absolute -top-2.5 -right-2.5" />}
    </div>
  );
}

