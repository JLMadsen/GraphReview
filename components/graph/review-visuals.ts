// The AI review's visual language — the one place a verdict's colour,
// glyph and word are defined, shared by every surface that shows an
// `assessment`: the review dock's chips and badges, the PR map's and app
// map's card badges, the area inspector's counts and the file viewer. A
// badge in the dock is therefore exactly the colour of the badge on the card
// it belongs to.
//
// What drives the colour is the *assessment* — is the change sound on its
// own terms: rose for defect, orchid for concern, slate for unknown, emerald
// for OK. Each also differs in lightness, not just hue. How a change relates
// to the PR's stated intent (`scope`) and what sort of change it is (`kind`)
// are neutral tags beside it, never a colour: a correct drive-by fix is green.
//
// Colour is never the only channel: every badge and chip also carries a
// plain glyph (✕ ▲ – ✓, no circle) and a written label, so the four states
// read with no colour perception at all.
//
// (`markerOpacity`/`markerPadding` and the class-name helpers below were
// for the removed Cytoscape Repo view's halos; nothing draws them now.)

import { Check, Minus, TriangleAlert, X } from "lucide-react";
import type { FindingDTO, Assessment, FindingKind, FindingScope } from "./types";

export interface AssessmentVisual {
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
   * finding is this state. `ok` is deliberately faint and tight (the
   * brief's "subtle or none"): it still says "reviewed, looks consistent"
   * without adding a fourth loud colour to a 109-node canvas.
   */
  markerOpacity: number;
  markerPadding: number;
}

export const ASSESSMENT_ORDER: Assessment[] = [
  "defect",
  "concern",
  "unknown",
  "ok",
];

export const ASSESSMENT_VISUALS: Record<Assessment, AssessmentVisual> = {
  defect: {
    label: "Defect",
    description: "The change looks wrong — or code it depends on was left behind.",
    color: "#fb3b53",
    text: "#ff8f9f",
    icon: X,
    rank: 0,
    markerOpacity: 0.55,
    markerPadding: 11,
  },
  concern: {
    label: "Concern",
    description: "Worth a closer look: risky, incomplete, or a behaviour change others rely on.",
    color: "#e879f9",
    text: "#f0abfc",
    icon: TriangleAlert,
    rank: 1,
    markerOpacity: 0.45,
    markerPadding: 9,
  },
  unknown: {
    label: "Unknown",
    description: "The model could not judge this change (or the call failed).",
    color: "#94a3b8",
    text: "#b8c2d2",
    icon: Minus,
    rank: 2,
    markerOpacity: 0.4,
    markerPadding: 8,
  },
  ok: {
    label: "OK",
    description: "The change looks correct on its own terms.",
    color: "#34d399",
    text: "#6ee7b7",
    icon: Check,
    rank: 3,
    markerOpacity: 0.2,
    markerPadding: 6,
  },
};

/** Cytoscape class names this layer owns — removed as a set before re-applying. */
export const ASSESSMENT_CLASS_NAMES = ASSESSMENT_ORDER.map(assessmentClassName).join(" ");

export function assessmentClassName(intent: Assessment): string {
  return `assessment-${intent}`;
}

/** Cytoscape class for a component holding a usage the change left behind (an impact finding). */
export const IMPACTED_CLASS_NAME = "impacted";
/** Dashed rose ring — the colour of `defect`, the shape of "not part of the diff". */
export const IMPACTED_COLOR = "#fb3b53";

/** `["defect", "concern", ...]` sorted worst-first. */
export function compareAssessment(a: Assessment, b: Assessment): number {
  return ASSESSMENT_VISUALS[a].rank - ASSESSMENT_VISUALS[b].rank;
}

/** The worse of two verdicts (`defect` beats `concern` beats `unknown` beats `ok`). */
export function worstAssessment(a: Assessment, b: Assessment): Assessment {
  return compareAssessment(a, b) <= 0 ? a : b;
}

/**
 * The verdict a finding counts as once reviewers have had their say: a
 * resolved finding counts as `ok`, whatever the model said. Everything
 * that ranks or colours by severity (markers, groups, the overall verdict)
 * goes through this; the filter chips keep the model's own verdict.
 */
export function effectiveAssessment(finding: FindingDTO): Assessment {
  return finding.resolvedAt ? "ok" : finding.assessment;
}

/** Only findings below `ok` have anything to resolve. */
export function isResolvable(finding: FindingDTO): boolean {
  return finding.assessment !== "ok";
}

// ---------------------------------------------------------------------------
// Scope / kind tags and finding categories
// ---------------------------------------------------------------------------

export const SCOPE_LABELS: Record<FindingScope, string> = {
  described: "Described",
  supporting: "Supporting",
  unmentioned: "Unmentioned",
};

export const SCOPE_DESCRIPTIONS: Record<FindingScope, string> = {
  described: "The PR's title, description or linked issues cover this change.",
  supporting: "Not named in the PR, but needed by what it describes.",
  unmentioned: "Not mentioned by the PR — a drive-by change. Informational only, never a problem by itself.",
};

export const KIND_LABELS: Record<FindingKind, string> = {
  fix: "Fix",
  feature: "Feature",
  refactor: "Refactor",
  test: "Test",
  docs: "Docs",
  config: "Config",
  chore: "Chore",
};

/**
 * The neutral tag beside a finding's verdict: "Drive-by fix",
 * "Unmentioned refactor", "Feature", … `null` when there's nothing to say.
 */
export function findingTag(finding: Pick<FindingDTO, "scope" | "kind">): string | null {
  const kind = finding.kind ? KIND_LABELS[finding.kind] : null;
  if (finding.scope === "unmentioned") {
    if (finding.kind === "fix") return "Drive-by fix";
    return kind ? `Unmentioned ${kind.toLowerCase()}` : "Unmentioned";
  }
  if (finding.scope === "supporting") return kind ? `Supporting ${kind.toLowerCase()}` : "Supporting";
  return kind;
}

/** The PR-level "does it deliver what it claims" verdict. */
export function isIntentFinding(finding: FindingDTO): boolean {
  return finding.category === "intent";
}

/** "Impact check incomplete: N usages were not checked" — a note, not a verdict. */
export function isImpactNote(finding: FindingDTO): boolean {
  return finding.category === "impact" && !finding.filePath;
}

/** A usage of a changed declaration that the change left behind. */
export function isImpactFinding(finding: FindingDTO): boolean {
  return finding.category === "impact" && !isImpactNote(finding);
}

/**
 * The changed declaration an impact finding is about (`isPendingJobState`),
 * read back from the summary lib/jobs/impact.ts writes:
 * "Not updated for the change to <name>: <reason>". `null` for anything else.
 */
export function impactSymbol(finding: Pick<FindingDTO, "category" | "summary">): string | null {
  if (finding.category !== "impact") return null;
  const match = /^Not updated for the change to (.+?):\s/.exec(finding.summary);
  return match ? match[1] : null;
}

/**
 * What happened to that declaration — "was removed from lib/jobs/queue.ts",
 * "in lib/x.ts changed from `a` to `b`" — from the rationale impact.ts
 * writes ("`name` <change>, but this line was not edited by the change." —
 * "these lines were" when one finding covers several lines of a file).
 */
export function impactChange(finding: Pick<FindingDTO, "category" | "rationale">): string | null {
  if (finding.category !== "impact") return null;
  const match = /^`[^`]+`\s+([\s\S]+?), but (?:this line was|these lines were) not edited/.exec(finding.rationale);
  return match ? match[1] : null;
}

/**
 * The model's reasons in an impact finding: one per line when the finding
 * covers several lines of a file (the rationale's "- line N: <reason>"
 * list), else the summary's "<reason>" part.
 */
export function impactReasons(finding: Pick<FindingDTO, "summary" | "rationale">): string[] {
  const perLine = [...finding.rationale.matchAll(/^- line \d+: (.+)$/gm)].map((m) => m[1].trim());
  if (perLine.length > 0) return perLine;
  return [finding.summary.replace(/^Not updated for the change to .+?:\s*/, "")];
}

/** What every verdict surface says on hover. */
export const REVIEW_ADVISORY =
  "Judged by the model on each change's own merits — it can be wrong. Nothing here blocks the PR or is posted anywhere.";

/** Per-component change findings. */
export function isChangeFinding(finding: FindingDTO): boolean {
  return finding.category === "change";
}

/** What the canvas needs per component to draw its marker and extend its tooltip. */
export interface ReviewMarker {
  componentName: string;
  /** Drives the marker colour — the single worst verdict among this component's findings. */
  worst: Assessment;
  /** How many findings this component has, across all verdicts. */
  count: number;
  /** The worst finding's summary, for the hover tooltip's extra line. */
  summary: string;
  /** How many open impact findings (usages the change left behind) sit in this component. */
  impacted: number;
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
    // The PR-level intent verdict and impact notes belong to no component.
    if (!finding.componentId) continue;
    const impacted = isImpactFinding(finding) && !finding.resolvedAt ? 1 : 0;
    const existing = markers[finding.componentId];
    if (!existing) {
      markers[finding.componentId] = {
        componentName: finding.componentName,
        worst: effectiveAssessment(finding),
        count: 1,
        summary: finding.summary,
        impacted,
      };
      continue;
    }
    existing.count += 1;
    existing.impacted += impacted;
    if (compareAssessment(effectiveAssessment(finding), existing.worst) < 0) {
      existing.worst = effectiveAssessment(finding);
      existing.summary = finding.summary;
    }
  }
  return markers;
}

/** Findings per verdict — powers both the panel's filter chips and the canvas legend. */
export function countByAssessment(
  findings: FindingDTO[]
): Record<Assessment, number> {
  const counts: Record<Assessment, number> = {
    defect: 0,
    concern: 0,
    unknown: 0,
    ok: 0,
  };
  for (const finding of findings) counts[finding.assessment] += 1;
  return counts;
}

/** Components per verdict (by their worst finding) — what the canvas legend counts, since that's what's drawn. */
export function countComponentsByAssessment(
  markers: ReviewMarkerMap
): Record<Assessment, number> {
  const counts: Record<Assessment, number> = {
    defect: 0,
    concern: 0,
    unknown: 0,
    ok: 0,
  };
  for (const marker of Object.values(markers)) counts[marker.worst] += 1;
  return counts;
}

/** The whole review in one verdict, for the dock header and the Markdown export. */
export interface ReviewVerdict {
  /** Worst effective verdict across every finding (resolved ones count as `ok`). */
  intent: Assessment;
  /** Findings below `ok` that nobody has resolved yet. */
  open: number;
  resolved: number;
  total: number;
}

/** `null` when there are no findings to judge. */
export function computeVerdict(findings: FindingDTO[]): ReviewVerdict | null {
  if (findings.length === 0) return null;
  let intent: Assessment = "ok";
  let open = 0;
  let resolved = 0;
  for (const finding of findings) {
    intent = worstAssessment(intent, effectiveAssessment(finding));
    if (finding.resolvedAt) resolved += 1;
    else if (isResolvable(finding)) open += 1;
  }
  return { intent, open, resolved, total: findings.length };
}

/** Escapes the few characters that would change a Markdown line's meaning. */
function mdInline(text: string): string {
  return text.replace(/\s+/g, " ").replace(/([\\`*_[\]|<>])/g, "\\$1").trim();
}

function mdFindingLine(finding: FindingDTO): string {
  const location = formatLocation(finding);
  const tag = isImpactFinding(finding) ? "Caller not updated" : isIntentFinding(finding) ? "Intent" : findingTag(finding);
  return [
    `**${ASSESSMENT_VISUALS[finding.assessment].label}**`,
    ...(tag ? [mdInline(tag)] : []),
    ...(finding.componentName ? [mdInline(finding.componentName)] : []),
    ...(location ? ["`" + location.replace(/`/g, "'") + "`"] : []),
  ].join(" · ") + ` — ${mdInline(finding.summary)}`;
}

/**
 * The overall assessment as Markdown, for pasting into a PR comment, a
 * ticket or a chat. Open findings first (worst first), then resolved ones,
 * then a count of the rest.
 */
export function reviewMarkdown(
  targetLabel: string,
  verdict: ReviewVerdict,
  findings: FindingDTO[],
  reviewedHeadSha?: string
): string {
  const bySeverity = (a: FindingDTO, b: FindingDTO) =>
    compareAssessment(a.assessment, b.assessment) ||
    (a.componentName || "").localeCompare(b.componentName || "");
  const intentFinding = findings.find(isIntentFinding);
  const notes = findings.filter(isImpactNote);
  const rest = findings.filter((f) => !isIntentFinding(f) && !isImpactNote(f));
  const open = rest.filter((f) => isResolvable(f) && !f.resolvedAt).sort(bySeverity);
  const resolved = rest.filter((f) => f.resolvedAt).sort(bySeverity);
  const oks = rest.filter((f) => !isResolvable(f)).length;
  const driveBys = rest.filter((f) => f.scope === "unmentioned" && f.assessment === "ok").length;

  const openCounts = ASSESSMENT_ORDER.filter((intent) => intent !== "ok")
    .map((intent) => ({ intent, n: open.filter((f) => f.assessment === intent).length }))
    .filter(({ n }) => n > 0)
    .map(({ intent, n }) => `${n} ${ASSESSMENT_VISUALS[intent].label.toLowerCase()}`);

  const lines = [
    `## AI review — ${mdInline(targetLabel)}`,
    "",
    `**Overall verdict: ${ASSESSMENT_VISUALS[verdict.intent].label}**` +
      (reviewedHeadSha ? ` (reviewed at \`${reviewedHeadSha.slice(0, 7)}\`)` : ""),
    ...(intentFinding
      ? [
          "",
          `**Delivers what it describes: ${ASSESSMENT_VISUALS[effectiveAssessment(intentFinding)].label}** — ${mdInline(intentFinding.summary)}`,
        ]
      : []),
    "",
    `${open.length} open finding${open.length === 1 ? "" : "s"}` +
      (openCounts.length > 0 ? ` (${openCounts.join(", ")})` : "") +
      ` · ${resolved.length} resolved · ${oks} OK` +
      (driveBys > 0 ? ` (${driveBys} unmentioned)` : ""),
    ...notes.map((f) => `_${mdInline(f.summary)}_`),
  ];
  if (open.length > 0) {
    lines.push("", "### Open findings", "", ...open.map((f) => `- ${mdFindingLine(f)}`));
  }
  if (resolved.length > 0) {
    lines.push(
      "",
      "### Resolved",
      "",
      ...resolved.map(
        (f) => `- ${mdFindingLine(f)} _(resolved ${(f.resolvedAt ?? "").slice(0, 10)})_`
      )
    );
  }
  lines.push("", "_Generated by GraphReview. Advisory only — AI can be wrong._");
  return lines.join("\n");
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
