// The PR map's cards as *areas* of the change (DESIGN.md §6.4): what the PR
// view, the review dock and the area inspector all have to agree on — which
// card a finding belongs to, and each card's files, lines and findings by
// severity. Pure; GraphView computes it once per map + findings and hands
// the same object to all three.

import type { PrMapNodeDTO, PrMapResponseDTO } from "./pr-map-types";
import type { FindingDTO } from "./types";
import { isImpactNote, isIntentFinding } from "./review-visuals";

/** The four ways the dock's filter chips and the cards' bars slice findings. */
export type FindingBucket = "defect" | "concern" | "unknown" | "fine";
export const FINDING_BUCKETS: FindingBucket[] = ["defect", "concern", "unknown", "fine"];

/** A finding's bucket once reviewers have had their say: resolved and OK findings are fine. */
export function findingBucket(finding: FindingDTO): FindingBucket {
  if (finding.resolvedAt || finding.assessment === "ok") return "fine";
  return finding.assessment;
}

/** Findings that belong to an area: everything but the PR-level verdict and the impact check's notes. */
export function isAreaFinding(finding: FindingDTO): boolean {
  return !isIntentFinding(finding) && !isImpactNote(finding);
}

export interface PrArea {
  node: PrMapNodeDTO;
  additions: number;
  deletions: number;
  /** This area's findings by bucket. */
  counts: Record<FindingBucket, number>;
  /** Open defects and concerns — the number on the card. */
  open: number;
  /** The map's edges from this card's side: "→ imports Database", "← API & UI queries". */
  links: string[];
}

export interface PrAreas {
  /** Every card of the map, in map order. */
  areas: Map<string, PrArea>;
  /** The card a finding belongs to — by its file, else by its component — or `undefined`. */
  areaOf: (finding: FindingDTO) => string | undefined;
}

const EMPTY: PrAreas = { areas: new Map(), areaOf: () => undefined };

/**
 * Whether a card is wholly new or wholly gone in this diff: every file
 * added (`new`) or every file deleted (`deleted`). Mixed cards, and the
 * unchanged neighbours, are `null` — the map only calls out the extremes.
 */
export type AreaLifecycle = "new" | "deleted";

export function areaLifecycle(node: PrMapNodeDTO): AreaLifecycle | null {
  if (node.role === "context" || node.files.length === 0) return null;
  if (node.files.every((f) => f.status === "added")) return "new";
  if (node.files.every((f) => f.status === "removed")) return "deleted";
  return null;
}

export function emptyCounts(): Record<FindingBucket, number> {
  return { defect: 0, concern: 0, unknown: 0, fine: 0 };
}

export function buildPrAreas(map: PrMapResponseDTO | null, findings: FindingDTO[]): PrAreas {
  if (!map) return EMPTY;
  const nameOf = new Map(map.nodes.map((n) => [n.id, n.name]));
  const cardOfFile = new Map<string, string>();
  for (const node of map.nodes) for (const file of node.files) cardOfFile.set(file.path, node.id);
  // A finding with no file on the map (an impact finding in an untouched
  // caller, a component-level placeholder) goes to the card holding most of
  // its component's code — or, failing that, the unchanged neighbour it is.
  const cardOfComponent = new Map<string, string>();
  for (const pass of ["code", "changed", "context"] as const) {
    for (const node of map.nodes) {
      if (pass === "code" && node.role !== "code") continue;
      if (pass === "changed" && node.role === "context") continue;
      for (const id of node.componentIds) if (!cardOfComponent.has(id)) cardOfComponent.set(id, node.id);
    }
  }
  const areaOf = (finding: FindingDTO): string | undefined =>
    (finding.filePath ? cardOfFile.get(finding.filePath) : undefined) ??
    (finding.componentId ? cardOfComponent.get(finding.componentId) : undefined);

  const areas = new Map<string, PrArea>();
  for (const node of map.nodes) {
    let additions = 0;
    let deletions = 0;
    for (const file of node.files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    const links: string[] = [];
    for (const edge of map.edges) {
      if (edge.source === node.id) links.push(`→ ${edge.label} ${nameOf.get(edge.target) ?? edge.target}`);
      else if (edge.target === node.id) links.push(`← ${nameOf.get(edge.source) ?? edge.source} ${edge.label}`);
    }
    areas.set(node.id, { node, additions, deletions, counts: emptyCounts(), open: 0, links });
  }
  for (const finding of findings) {
    if (!isAreaFinding(finding)) continue;
    const id = areaOf(finding);
    const area = id ? areas.get(id) : undefined;
    if (!area) continue;
    const bucket = findingBucket(finding);
    area.counts[bucket] += 1;
    if (bucket === "defect" || bucket === "concern") area.open += 1;
  }
  return { areas, areaOf };
}
