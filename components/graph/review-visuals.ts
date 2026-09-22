// The AI-review highlight layer's visual language — DESIGN.md §6.2, §9, §10.
//
// Single source of truth shared by every surface that renders an
// `intentMatch`: the Cytoscape `underlay-*` markers in `GraphCanvas`, the
// legend chips next to them, `ReviewPanel`'s filter chips and finding
// badges, and `ComponentFilesPanel`'s compact per-component list. A badge in
// the panel is therefore exactly the colour of the halo on the node it
// points at, the same way `IMPACT_COLORS` ties the impact legend to the
// node fills.
//
// ---------------------------------------------------------------------------
// Why these colours
// ---------------------------------------------------------------------------
// This is the *third* independent highlight layer on the canvas, and it has
// to stay readable on top of the other two without being mistaken for
// either:
//
//   layer 1 (impact)    — node FILL: amber #f0a92b / indigo #6366f1 / slate
//   layer 2 (selection) — BORDER + opacity: near-white / sky #7dd3fc
//   layer 3 (this one)  — UNDERLAY halo behind the node
//
// So the palette deliberately avoids amber, indigo and sky: rose for
// mismatch, orchid for partial, a neutral slate for unknown, and emerald for
// match. Each also differs in lightness, not just hue.
//
// Colour is never the only channel, per the accessibility requirement: every
// badge and chip carries a distinct lucide glyph *and* a written label, so
// the four states are separable with no colour perception at all. The graph
// marker is colour-only by necessity (a glyph inside a 30px node would be
// illegible at whole-graph zoom), which is exactly why the marker is a
// redundant cue — the authoritative, labelled list is in `ReviewPanel`.

import { CircleAlert, CircleCheck, CircleHelp, CircleX } from "lucide-react";
import type { FindingDTO, IntentMatch } from "./types";

export interface IntentVisual {
  /** Short, written label — the colour-independent channel. */
  label: string;
  /** One-line explanation, used as chip `title` text. */
  description: string;
  /** The accent: Cytoscape underlay colour, chip dot, badge ring. */
  color: string;
  /** A lighter tint of `color`, legible as text on the dark card surface. */
  text: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Worst-first ordering — 0 sorts first. */
  rank: number;
  /**
   * Cytoscape `underlay-opacity`/`underlay-padding` for a node whose worst
   * finding is this state. `match` is deliberately faint and tight (the
   * brief's "subtle or none"): it still says "reviewed, looks consistent"
   * without adding a fourth loud colour to a 109-node canvas.
   */
  markerOpacity: number;
  markerPadding: number;
}

export const INTENT_ORDER: IntentMatch[] = [
  "mismatch",
  "partial",
  "unknown",
  "match",
];

export const INTENT_VISUALS: Record<IntentMatch, IntentVisual> = {
  mismatch: {
    label: "Mismatch",
    description: "The change does not match the stated intent.",
    color: "#fb3b53",
    text: "#ff8f9f",
    icon: CircleX,
    rank: 0,
    markerOpacity: 0.55,
    markerPadding: 11,
  },
  partial: {
    label: "Partial",
    description: "Only part of the change matches the stated intent.",
    color: "#e879f9",
    text: "#f0abfc",
    icon: CircleAlert,
    rank: 1,
    markerOpacity: 0.45,
    markerPadding: 9,
  },
  unknown: {
    label: "Unknown",
    description: "The model could not judge this change (or the call failed).",
    color: "#94a3b8",
    text: "#b8c2d2",
    icon: CircleHelp,
    rank: 2,
    markerOpacity: 0.4,
    markerPadding: 8,
  },
  match: {
    label: "Match",
    description: "The change is consistent with the stated intent.",
    color: "#34d399",
    text: "#6ee7b7",
    icon: CircleCheck,
    rank: 3,
    markerOpacity: 0.2,
    markerPadding: 6,
  },
};

/** Cytoscape class names this layer owns — removed as a set before re-applying. */
export const INTENT_CLASS_NAMES = INTENT_ORDER.map(intentClassName).join(" ");

export function intentClassName(intent: IntentMatch): string {
  return `intent-${intent}`;
}

/** `["mismatch", "partial", ...]` sorted worst-first. */
export function compareIntent(a: IntentMatch, b: IntentMatch): number {
  return INTENT_VISUALS[a].rank - INTENT_VISUALS[b].rank;
}

/** The worse of two verdicts (`mismatch` beats `partial` beats `unknown` beats `match`). */
export function worstIntent(a: IntentMatch, b: IntentMatch): IntentMatch {
  return compareIntent(a, b) <= 0 ? a : b;
}

/** What the canvas needs per component to draw its marker and extend its tooltip. */
export interface ReviewMarker {
  componentName: string;
  /** Drives the marker colour — the single worst verdict among this component's findings. */
  worst: IntentMatch;
  /** How many findings this component has, across all verdicts. */
  count: number;
  /** The worst finding's summary, for the hover tooltip's extra line. */
  summary: string;
}

export type ReviewMarkerMap = Record<string, ReviewMarker>;

/**
 * Collapses a flat finding list into one marker per component, keeping the
 * worst verdict (and that finding's summary). Ties keep the first finding
 * seen, which — given the API returns findings in a stable order — keeps the
 * tooltip text from flickering between polls while a review streams in.
 */
export function buildReviewMarkers(findings: FindingDTO[]): ReviewMarkerMap {
  const markers: ReviewMarkerMap = {};
  for (const finding of findings) {
    const existing = markers[finding.componentId];
    if (!existing) {
      markers[finding.componentId] = {
        componentName: finding.componentName,
        worst: finding.intentMatch,
        count: 1,
        summary: finding.summary,
      };
      continue;
    }
    existing.count += 1;
    if (compareIntent(finding.intentMatch, existing.worst) < 0) {
      existing.worst = finding.intentMatch;
      existing.summary = finding.summary;
    }
  }
  return markers;
}

/** Findings per verdict — powers both the panel's filter chips and the canvas legend. */
export function countByIntent(
  findings: FindingDTO[]
): Record<IntentMatch, number> {
  const counts: Record<IntentMatch, number> = {
    mismatch: 0,
    partial: 0,
    unknown: 0,
    match: 0,
  };
  for (const finding of findings) counts[finding.intentMatch] += 1;
  return counts;
}

/** Components per verdict (by their worst finding) — what the canvas legend counts, since that's what's drawn. */
export function countComponentsByIntent(
  markers: ReviewMarkerMap
): Record<IntentMatch, number> {
  const counts: Record<IntentMatch, number> = {
    mismatch: 0,
    partial: 0,
    unknown: 0,
    match: 0,
  };
  for (const marker of Object.values(markers)) counts[marker.worst] += 1;
  return counts;
}

/** `"src/x.ts:12-40"`, or just the path, or `null` when the finding has neither. */
export function formatLocation(finding: FindingDTO): string | null {
  if (!finding.filePath) return null;
  return finding.lineRange
    ? `${finding.filePath}:${finding.lineRange}`
    : finding.filePath;
}

/** `0.82` → `"82%"`. */
export function formatConfidence(confidence: number): string {
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}
