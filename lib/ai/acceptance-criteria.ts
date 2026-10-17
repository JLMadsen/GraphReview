// Acceptance criteria (DESIGN.md §6.27): read deterministically out of the
// PR description and its linked issues, then judged one by one by the PR
// intent call (./pr-intent.ts).
//
// Three formats are recognised:
//
//   checkbox  `- [ ] text` / `- [x] text`, anywhere in the text
//   gherkin   a Given/When/Then block (And/But continue it), optionally
//             headed by `Scenario: …`; the whole block is one criterion
//   heading   list items under a heading (or a bold/colon label line) such
//             as "Acceptance criteria", "AC" or "Definition of done"
//
// Fenced code blocks and HTML comments (PR templates' hints) are skipped.
// A criterion ticked in the issue keeps `ticked: true` but is still checked
// against the code — ticking is a claim, not evidence.

import type { ReviewIntent } from "./review";

export type AcceptanceCriterionFormat = "checkbox" | "gherkin" | "heading";

export interface AcceptanceCriterion {
  /** Short wire id (c1, c2, …) — the model copies it back. */
  id: string;
  /** The criterion as written (Gherkin blocks keep their line breaks). */
  text: string;
  /** `"description"` or `"#<issue number>"`. */
  source: string;
  format: AcceptanceCriterionFormat;
  /** Checkbox criteria: ticked in the description or issue. */
  ticked?: boolean;
}

export type CriterionVerdict = "pass" | "fail" | "unknown";

/** A place in the diff a verdict points at. */
export interface CriterionEvidence {
  path: string;
  /** `"12"` or `"12-18"`, head-side line numbers. */
  lines?: string;
}

export interface CriterionResult {
  id: string;
  verdict: CriterionVerdict;
  /** Plain words; says so when there is no evidence. */
  reason: string;
  evidence: CriterionEvidence[];
}

export const MAX_CRITERIA = 30;
const MAX_CRITERION_CHARS = 500;

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
/** A line that is only a label: `**Acceptance criteria**`, `**AC:**`, `Definition of done:`. */
const BOLD_LABEL_RE = /^\s{0,3}(\*\*|__)(.{1,60}?)\1\s*:?\s*$/;
const COLON_LABEL_RE = /^\s{0,3}([^\s*_#>-][^:]{0,59}):\s*$/;
const AC_TITLE_RE = /^(?:acceptance\s+criteria|acceptance\s+criterion|acceptance\s+tests?|ac|ac's|acs|definition\s+of\s+done|dod)(?:\s*\(.*\))?$/i;
const LIST_RE = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const CHECKBOX_RE = /^\[([ xX])\]\s+(.*)$/;
const GWT_RE = /^(?:(?:[-*+]|\d{1,3}[.)])\s+)?(?:\*\*|__)?(given|when|then|and|but)\b(?:\*\*|__)?[:,]?\s*(.*)$/i;
const SCENARIO_RE = /^(?:(?:[-*+]|\d{1,3}[.)])\s+)?(?:\*\*|__)?(?:scenario(?:\s+outline)?|example)(?:\*\*|__)?\s*:\s*(.*)$/i;

function stripNoise(text: string): string[] {
  const withoutComments = text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const out: string[] = [];
  // A Gherkin block in a ```gherkin fence is still criteria; other fences are code.
  let fence: { marker: string; keep: boolean } | null = null;
  for (const line of withoutComments.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length) fence = null;
      else if (fence.keep) out.push(line);
      continue;
    }
    if (marker) {
      fence = { marker, keep: /^\s*(`{3,}|~{3,})\s*(gherkin|feature|cucumber)\s*$/i.test(line) };
      continue;
    }
    out.push(line);
  }
  return out;
}

function clip(text: string): string {
  const t = text.trim();
  return t.length <= MAX_CRITERION_CHARS ? t : `${t.slice(0, MAX_CRITERION_CHARS - 1)}…`;
}

/** The criteria in one block of markdown, in order. */
export function parseCriteriaFromText(
  text: string | undefined,
  source: string
): Array<Omit<AcceptanceCriterion, "id">> {
  if (!text?.trim()) return [];
  const found: Array<Omit<AcceptanceCriterion, "id"> & { indent?: number }> = [];
  let acLevel: number | null = null; // the heading level of the open AC section (7 = a label line)
  let gwt: string[] | null = null;
  let scenario: string | null = null;

  const closeGwt = () => {
    const lines: string[] | null = gwt;
    if (lines && lines.length > 0) {
      found.push({ text: clip([...(scenario ? [`Scenario: ${scenario}`] : []), ...lines].join("\n")), source, format: "gherkin" });
    }
    gwt = null;
    scenario = null;
  };

  for (const raw of stripNoise(text)) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();

    // Gherkin first: its lines may also look like list items.
    const g = GWT_RE.exec(trimmed);
    if (g && g[2].trim()) {
      const keyword = g[1].toLowerCase();
      // Given (or a When with no Given) starts a block; a second Given starts the next one.
      if (keyword === "given" || (keyword === "when" && !gwt)) {
        if (gwt) closeGwt();
        gwt = [];
      }
      if (gwt) {
        gwt.push(`${g[1][0].toUpperCase()}${g[1].slice(1).toLowerCase()} ${g[2].trim()}`);
        continue;
      }
    }
    const s = SCENARIO_RE.exec(trimmed);
    if (s) {
      closeGwt();
      scenario = s[1].trim() || null;
      continue;
    }
    if (gwt && trimmed === "") continue; // a blank line inside a block doesn't end it…
    if (gwt) closeGwt(); // …anything else does

    const h = HEADING_RE.exec(line);
    const bold = h || LIST_RE.test(line) ? null : BOLD_LABEL_RE.exec(line);
    const colon = h || bold || LIST_RE.test(line) ? null : COLON_LABEL_RE.exec(line);
    const heading = h?.[2] ?? bold?.[2] ?? colon?.[1];
    if (heading !== undefined) {
      const level = h ? h[1].length : 7;
      const title = heading.replace(/[*_`]/g, "").replace(/[:：]\s*$/, "").trim();
      if (AC_TITLE_RE.test(title)) {
        acLevel = level;
        continue;
      }
      // A heading of the same or a higher level ends the section; a label line only ends a label section.
      if (acLevel !== null && (h ? level <= acLevel || acLevel === 7 : acLevel === 7)) acLevel = null;
      continue;
    }

    const item = LIST_RE.exec(line);
    if (!item) continue;
    const indent = item[1].replace(/\t/g, "    ").length;
    const body = item[2].trim();
    const box = CHECKBOX_RE.exec(body);
    const content = (box ? box[2] : body).trim();
    if (!content) continue;

    // A nested item under a criterion of the same section belongs to it.
    const last = found[found.length - 1];
    if (last && last.indent !== undefined && indent > last.indent && (acLevel !== null || box)) {
      last.text = clip(`${last.text} — ${content}`);
      continue;
    }
    if (box) {
      found.push({ text: clip(content), source, format: acLevel !== null ? "heading" : "checkbox", ticked: box[1] !== " ", indent });
    } else if (acLevel !== null) {
      found.push({ text: clip(content), source, format: "heading", indent });
    }
  }
  closeGwt();
  return found.map((c) => ({ text: c.text, source: c.source, format: c.format, ...(c.ticked !== undefined ? { ticked: c.ticked } : {}) }));
}

/** Lower-cased, whitespace- and punctuation-folded — for matching a stored verdict to a criterion. */
export function criterionKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Every criterion in the PR description and its linked issues, deduplicated
 * by text (the first occurrence wins), numbered c1…cN, at most MAX_CRITERIA.
 * Ref comparisons have no stated intent, so no criteria.
 */
export function parseAcceptanceCriteria(intent: ReviewIntent): AcceptanceCriterion[] {
  if (intent.source !== "pull_request") return [];
  const all = [
    ...parseCriteriaFromText(intent.body, "description"),
    ...(intent.linkedIssues ?? []).flatMap((issue) => parseCriteriaFromText(issue.body, `#${issue.number}`)),
  ];
  const seen = new Set<string>();
  const out: AcceptanceCriterion[] = [];
  for (const c of all) {
    const key = criterionKey(c.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `c${out.length + 1}`, ...c });
    if (out.length >= MAX_CRITERIA) break;
  }
  return out;
}
