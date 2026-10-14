// Fuzzy matching for the command palette (DESIGN.md §6.18). Pure — used by
// the search route to rank and by the palette to highlight what matched.
//
// A query matches when its characters appear in the text in order
// (whitespace in the query is ignored). The score rewards a contiguous
// substring, a match at the start of a word (after `/ . _ - #`, a space, or a
// lower→upper case change), consecutive characters and an early start; it
// is 0..~200, higher is better.

const BOUNDARY = /[\/._\-#\s:]/;

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (BOUNDARY.test(prev)) return true;
  const cur = text[i];
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase();
}

export interface FuzzyMatch {
  score: number;
  /** Indexes into the text of the matched characters. */
  indexes: number[];
}

/** How well `query` matches `text`, or null when it doesn't. An empty query matches everything with score 0. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { score: 0, indexes: [] };
  const lower = text.toLowerCase();

  // A contiguous substring beats any scattered match: prefer one at a word start.
  let at = -1;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + 1)) {
    if (at === -1) at = i;
    if (isBoundary(text, i)) {
      at = i;
      break;
    }
  }
  if (at !== -1) {
    const indexes = Array.from({ length: q.length }, (_, k) => at + k);
    let score = 100 + q.length * 4 - Math.min(at, 40) * 0.5;
    if (isBoundary(text, at)) score += 30;
    if (at === 0) score += 15;
    if (q.length === lower.length) score += 40;
    return { score, indexes };
  }

  // Scattered: left to right, jumping ahead to a word start when there is one;
  // that jump can strand a later character, so plain greedy is the fallback.
  const indexes = subsequence(text, lower, q, true) ?? subsequence(text, lower, q, false);
  if (!indexes) return null;
  // Scattered across the middles of words is noise, not a match: allow few
  // runs that don't start a word (`gvw` → GraphView is fine; `palette` →
  // a`p`p/`a`pi/chec`kl`is`t`/it`e`ms is not).
  let loose = 0;
  for (let k = 0; k < indexes.length; k++) {
    const startsRun = k === 0 || indexes[k] !== indexes[k - 1] + 1;
    if (startsRun && !isBoundary(text, indexes[k])) loose++;
  }
  if (loose > 1 + Math.floor(q.length / 2)) return null;
  let score = 20;
  for (let k = 0; k < indexes.length; k++) {
    const i = indexes[k];
    if (isBoundary(text, i)) score += 8;
    if (k > 0 && i === indexes[k - 1] + 1) score += 5;
  }
  score -= Math.min(indexes[0], 40) * 0.3;
  score -= Math.min(indexes[indexes.length - 1] - indexes[0] - indexes.length, 60) * 0.2;
  return { score, indexes };
}

function subsequence(text: string, lower: string, q: string, preferBoundary: boolean): number[] | null {
  const indexes: number[] = [];
  let from = 0;
  for (const ch of q) {
    let pick = -1;
    for (let i = lower.indexOf(ch, from); i !== -1; i = lower.indexOf(ch, i + 1)) {
      if (pick === -1) pick = i;
      if (!preferBoundary) break;
      if (isBoundary(text, i)) {
        pick = i;
        break;
      }
      // Don't skip past a consecutive match looking for a boundary.
      if (indexes.length && i === indexes[indexes.length - 1] + 1) break;
    }
    if (pick === -1) return null;
    indexes.push(pick);
    from = pick + 1;
  }
  return indexes;
}

/** A file path: the base name counts more than the folders. */
export function fuzzyMatchPath(query: string, path: string): FuzzyMatch | null {
  const whole = fuzzyMatch(query, path);
  if (!whole) return null;
  const slash = path.lastIndexOf("/");
  if (slash === -1) return { ...whole, score: whole.score + 20 };
  const base = fuzzyMatch(query, path.slice(slash + 1));
  if (base && base.score + 20 >= whole.score) {
    return { score: base.score + 20, indexes: base.indexes.map((i) => i + slash + 1) };
  }
  return whole;
}

/** A SQL `LIKE` pattern every fuzzy match of `query` satisfies (`%a%b%c%`), with `\` as the escape. */
export function subsequenceLike(query: string): string {
  const chars = [...query.replace(/\s+/g, "")].map((c) => (c === "%" || c === "_" || c === "\\" ? `\\${c}` : c));
  return `%${chars.join("%")}%`;
}
