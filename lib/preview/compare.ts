// Comparing one case's before and after (DESIGN.md §6.9). Pure and
// client-safe: the job uses it to set `differs`, and the UI and the scan
// endpoint use it on stored results, so results written by an older
// version are judged the same way.
//
// "Different" needs a result on *both* sides. When one side produced
// nothing usable — the module didn't load, or a component threw instead of
// rendering (often `notFound()`, because the sandbox has no data) — that is
// not a visual difference but a side that failed, reported as such.

import type { PreviewCaseOutcome, PreviewCaseResult, PreviewSymbolResult } from "./types";

type SymbolShape = Pick<PreviewSymbolResult, "kind" | "change">;

/** Whether a side produced a result worth comparing: markup for a component; any outcome (a return or a throw) for a function. */
export function usableOutcome(kind: SymbolShape["kind"], outcome: PreviewCaseOutcome | undefined): boolean {
  if (!outcome) return false;
  return kind === "component" ? outcome.html !== undefined : true;
}

function sameOutcome(a: PreviewCaseOutcome, b: PreviewCaseOutcome): boolean {
  return a.returned === b.returned && a.argsAfter === b.argsAfter && a.html === b.html && a.threw === b.threw;
}

/** The side of a modified symbol that failed while the other worked, or `null`. */
export function brokenSide(
  symbol: SymbolShape,
  item: Pick<PreviewCaseResult, "before" | "after">
): "before" | "after" | null {
  if (symbol.change !== "modified") return null;
  const before = usableOutcome(symbol.kind, item.before);
  const after = usableOutcome(symbol.kind, item.after);
  if (before && !after) return "after";
  if (!before && after) return "before";
  return null;
}

/**
 * Whether before and after genuinely disagree. Added/removed symbols always
 * do (one side has no such symbol); a modified one only when both sides
 * produced something to compare and it isn't the same.
 */
export function caseDiffers(symbol: SymbolShape, item: Pick<PreviewCaseResult, "before" | "after">): boolean {
  if (symbol.change !== "modified") return true;
  if (!usableOutcome(symbol.kind, item.before) || !usableOutcome(symbol.kind, item.after)) return false;
  return !sameOutcome(item.before!, item.after!);
}

export type PreviewSymbolStatus = "different" | "new" | "removed" | "same" | "failed" | "breaks" | "recovers";

/**
 * One symbol's overall verdict.
 *
 * - `failed`: nothing usable on either side — it didn't run.
 * - `breaks` / `recovers`: works on one side only (after / before failed).
 * - `different` / `same`: both sides worked and do / don't disagree.
 */
export function symbolStatus(symbol: Pick<PreviewSymbolResult, "kind" | "change" | "cases">): PreviewSymbolStatus {
  const ran = symbol.cases.some(
    (c) => usableOutcome(symbol.kind, c.before) || usableOutcome(symbol.kind, c.after)
  );
  if (!ran) return "failed";
  if (symbol.change === "added") return "new";
  if (symbol.change === "removed") return "removed";
  const broken = symbol.cases.map((c) => brokenSide(symbol, c));
  if (broken.includes("after")) return "breaks";
  if (broken.includes("before")) return "recovers";
  return symbol.cases.some((c) => caseDiffers(symbol, c)) ? "different" : "same";
}
