// The review dock's list rows: findings sorted exceptions-first, impact findings grouped.

import {
  compareAssessment,
  impactChange,
  impactSymbol,
} from "../review-visuals";
import { findingBucket, type FindingBucket } from "../pr-areas";
import {
  type FindingDTO,
} from "../types";

export function compareFindings(a: FindingDTO, b: FindingDTO): number {
  return (
    compareAssessment(a.assessment, b.assessment) ||
    Number(Boolean(a.callFailed)) - Number(Boolean(b.callFailed)) ||
    b.confidence - a.confidence ||
    (a.componentName || "").localeCompare(b.componentName || "") ||
    (a.filePath || "").localeCompare(b.filePath || "")
  );
}

/** One line of the findings list: a finding, or every usage of one changed declaration. */
export type ListRow =
  | { kind: "one"; key: string; bucket: FindingBucket; finding: FindingDTO }
  | { kind: "group"; key: string; bucket: FindingBucket; symbol: string; change: string | null; findings: FindingDTO[] };

export const BUCKET_RANK: Record<FindingBucket, number> = { defect: 0, concern: 1, unknown: 2, fine: 3 };

export function buildRows(findings: FindingDTO[]): ListRow[] {
  const rows: ListRow[] = [];
  const groups = new Map<string, Extract<ListRow, { kind: "group" }>>();
  for (const finding of findings) {
    const symbol = impactSymbol(finding);
    if (!symbol) {
      rows.push({ kind: "one", key: finding.id, bucket: findingBucket(finding), finding });
      continue;
    }
    const change = impactChange(finding);
    const key = `impact:${symbol}\u0000${change ?? ""}`;
    const group = groups.get(key);
    if (group) group.findings.push(finding);
    else {
      const row = { kind: "group" as const, key, bucket: "fine" as FindingBucket, symbol, change, findings: [finding] };
      groups.set(key, row);
      rows.push(row);
    }
  }
  for (const group of groups.values()) {
    group.findings.sort((a, b) => (a.filePath || "").localeCompare(b.filePath || "") || Number(a.lineRange) - Number(b.lineRange));
    const open = group.findings.find((f) => !f.resolvedAt);
    group.bucket = open ? findingBucket(open) : "fine";
  }
  const size = (row: ListRow) => (row.kind === "group" ? row.findings.length : 1);
  return rows.sort(
    (a, b) =>
      BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] ||
      size(b) - size(a) ||
      (a.kind === "one" && b.kind === "one" ? compareFindings(a.finding, b.finding) : 0)
  );
}
