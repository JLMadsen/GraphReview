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

import { Check, Minus, TriangleAlert, X } from "lucide-react";
import type { FindingDTO, Assessment, FindingKind, FindingScope } from "./types";
import type { AcceptanceCriterionRowDTO } from "./checklist-types";

export interface AssessmentVisual {
  /** Short, written label — the colour-independent channel. */
  label: string;
  /** One-line explanation, used as chip `title` text. */
  description: string;
  /** The accent: chip dot, badge ring, card badge. */
  color: string;
  /** A lighter tint of `color`, legible as text on the dark card surface. */
  text: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Worst-first ordering — 0 sorts first. */
  rank: number;
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
  },
  concern: {
    label: "Concern",
    description: "Worth a closer look: risky, incomplete, or a behaviour change others rely on.",
    color: "#e879f9",
    text: "#f0abfc",
    icon: TriangleAlert,
    rank: 1,
  },
  unknown: {
    label: "Unknown",
    description: "The model could not judge this change (or the call failed).",
    color: "#94a3b8",
    text: "#b8c2d2",
    icon: Minus,
    rank: 2,
  },
  ok: {
    label: "OK",
    description: "The change looks correct on its own terms.",
    color: "#34d399",
    text: "#6ee7b7",
    icon: Check,
    rank: 3,
  },
};

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
 * that ranks or colours by severity (card badges, groups, the overall verdict)
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
  "Judged by the model on each change's own merits — it can be wrong. Nothing here blocks the PR, and nothing is posted unless you post it.";

/** Per-component change findings. */
export function isChangeFinding(finding: FindingDTO): boolean {
  return finding.category === "change";
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
export function mdInline(text: string): string {
  return text.replace(/\s+/g, " ").replace(/([\\`*_[\]|<>])/g, "\\$1").trim();
}

/** Text as inline code, whatever backticks it holds. */
export function mdCode(text: string): string {
  return "`" + text.replace(/`/g, "'") + "`";
}

/** "**Defect** · Drive-by fix · Jobs · `lib/x.ts:12` — summary" */
export function mdFindingLine(finding: FindingDTO): string {
  const location = formatLocation(finding);
  const tag = isImpactFinding(finding) ? "Caller not updated" : isIntentFinding(finding) ? "Intent" : findingTag(finding);
  return [
    `**${ASSESSMENT_VISUALS[finding.assessment].label}**`,
    ...(tag ? [mdInline(tag)] : []),
    ...(finding.componentName ? [mdInline(finding.componentName)] : []),
    ...(location ? [mdCode(location)] : []),
  ].join(" · ") + ` — ${mdInline(finding.summary)}`;
}

/** A rationale as a quote indented under a list item, clipped to `max` characters. */
function mdRationale(text: string, max: number): string[] {
  const trimmed = text.trim();
  const clipped = trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
  return clipped
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => `  > ${line.trim()}`);
}

export interface ReviewMarkdownOptions {
  /** Quote each open finding's reasoning under it, clipped to this many characters (the full report). */
  rationaleChars?: number;
  /** Leave impact findings out of the lists (the full report gives them a section of their own). */
  omitImpact?: boolean;
  /** The checklist's acceptance-criteria rows (DESIGN.md §6.27), if the PR states any. */
  criteria?: AcceptanceCriterionRowDTO[];
}

/**
 * The overall assessment as Markdown, for pasting into a PR comment, a
 * ticket or a chat. Open findings first (worst first), then resolved ones,
 * then a count of the rest. The full report — checklist, catalog diffs,
 * previews — is lib/review-post/report.ts, which reuses `reviewMarkdownBody`.
 */
export function reviewMarkdown(
  targetLabel: string,
  verdict: ReviewVerdict,
  findings: FindingDTO[],
  reviewedHeadSha?: string,
  /** The checklist's acceptance-criteria rows (DESIGN.md §6.27), if the PR states any. */
  criteria?: AcceptanceCriterionRowDTO[]
): string {
  return [
    `## AI review — ${mdInline(targetLabel)}`,
    "",
    ...reviewMarkdownBody(verdict, findings, reviewedHeadSha, { criteria }),
    "",
    "_Generated by GraphReview. Advisory only — AI can be wrong._",
  ].join("\n");
}

/** The verdict, intent and count lines, then the open and resolved findings. */
export function reviewMarkdownBody(
  verdict: ReviewVerdict,
  findings: FindingDTO[],
  reviewedHeadSha?: string,
  options: ReviewMarkdownOptions = {}
): string[] {
  const bySeverity = (a: FindingDTO, b: FindingDTO) =>
    compareAssessment(a.assessment, b.assessment) ||
    (a.componentName || "").localeCompare(b.componentName || "");
  const intentFinding = findings.find(isIntentFinding);
  const notes = findings.filter(isImpactNote);
  const rest = findings.filter((f) => !isIntentFinding(f) && !isImpactNote(f));
  const listed = options.omitImpact ? rest.filter((f) => !isImpactFinding(f)) : rest;
  const openAll = rest.filter((f) => isResolvable(f) && !f.resolvedAt);
  const open = listed.filter((f) => isResolvable(f) && !f.resolvedAt).sort(bySeverity);
  const resolved = listed.filter((f) => f.resolvedAt).sort(bySeverity);
  const resolvedCount = rest.filter((f) => f.resolvedAt).length;
  const oks = rest.filter((f) => !isResolvable(f)).length;
  const driveBys = rest.filter((f) => f.scope === "unmentioned" && f.assessment === "ok").length;

  const openCounts = ASSESSMENT_ORDER.filter((intent) => intent !== "ok")
    .map((intent) => ({ intent, n: openAll.filter((f) => f.assessment === intent).length }))
    .filter(({ n }) => n > 0)
    .map(({ intent, n }) => `${n} ${ASSESSMENT_VISUALS[intent].label.toLowerCase()}`);

  const lines = [
    `**Overall verdict: ${ASSESSMENT_VISUALS[verdict.intent].label}**` +
      (reviewedHeadSha ? ` (reviewed at \`${reviewedHeadSha.slice(0, 7)}\`)` : ""),
    ...(intentFinding
      ? [
          "",
          `**Delivers what it describes: ${ASSESSMENT_VISUALS[effectiveAssessment(intentFinding)].label}** — ${mdInline(intentFinding.summary)}`,
        ]
      : []),
    "",
    `${openAll.length} open finding${openAll.length === 1 ? "" : "s"}` +
      (openCounts.length > 0 ? ` (${openCounts.join(", ")})` : "") +
      ` · ${resolvedCount} resolved · ${oks} OK` +
      (driveBys > 0 ? ` (${driveBys} unmentioned)` : ""),
    ...notes.map((f) => `_${mdInline(f.summary)}_`),
  ];
  const criteria = options.criteria;
  if (criteria && criteria.length > 0) {
    const met = criteria.filter((c) => c.verdict === "pass").length;
    const mark = { pass: "✓ Met", fail: "✕ Not met", unknown: "? Can't tell", pending: "… Not judged yet" } as const;
    lines.push(
      "",
      `### Acceptance criteria (${met}/${criteria.length} met)`,
      "",
      ...criteria.map(
        (c) =>
          `- ${mark[c.verdict]} — ${mdInline(c.text.replace(/\s*\n\s*/g, " / "))}` +
          ` _(${c.source === "description" ? "description" : `issue ${c.source}`}${c.ticked ? ", ticked" : ""})_` +
          (c.reason ? ` — ${mdInline(c.reason)}` : "") +
          (c.evidence.length > 0 ? ` · ${c.evidence.map((e) => "`" + `${e.path}${e.lines ? `:${e.lines}` : ""}`.replace(/`/g, "'") + "`").join(", ")}` : "")
      )
    );
  }
  if (open.length > 0) {
    lines.push(
      "",
      "### Open findings",
      "",
      ...open.flatMap((f) => [
        `- ${mdFindingLine(f)}`,
        ...(options.rationaleChars ? mdRationale(f.rationale, options.rationaleChars) : []),
      ])
    );
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
  return lines;
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
