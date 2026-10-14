// Packs already laid-out boxes (the Data view's component boxes, CardFlow
// `groups`) so boxes joined by links sit next to each other. ELK's
// rectpacking, which this replaced, keeps the input order and knows nothing
// of links, so two closely linked apps could end up in opposite corners.
//
// Greedy: the box with the most links goes first; then, one at a time, the
// unplaced box with the most links to those already placed, at the free spot
// that keeps those links shortest (measured between the linked cards, not the
// box centres) while stretching the whole as little as possible past the
// target aspect ratio. Unlinked boxes come last, largest first, and fill gaps.

export type PackPoint = { x: number; y: number };

export interface PackLink {
  /** Indexes of the two boxes. */
  a: number;
  b: number;
  /** Where the link ends inside each box, relative to that box's top-left. */
  pa: PackPoint;
  pb: PackPoint;
}

type Rect = { x: number; y: number; width: number; height: number };

/** Each box's top-left, packed from (padding, padding). */
export function packBoxes(
  boxes: ReadonlyArray<{ width: number; height: number }>,
  links: readonly PackLink[],
  { aspect = 1.8, gap = 56, padding = 24 }: { aspect?: number; gap?: number; padding?: number } = {}
): PackPoint[] {
  const n = boxes.length;
  if (n === 0) return [];
  const ends: Array<Array<{ other: number; self: PackPoint; at: PackPoint }>> = boxes.map(() => []);
  for (const l of links) {
    if (l.a === l.b || !boxes[l.a] || !boxes[l.b]) continue;
    ends[l.a].push({ other: l.b, self: l.pa, at: l.pb });
    ends[l.b].push({ other: l.a, self: l.pb, at: l.pa });
  }
  const area = (i: number) => boxes[i].width * boxes[i].height;

  const pos: Array<PackPoint | undefined> = new Array(n);
  const placed: number[] = [];
  let bbox: Rect | null = null;
  /** The bounding box's width at the target aspect ratio: growing the side that doesn't bind yet is free. */
  const size = (b: Rect) => Math.max(b.width, b.height * aspect);

  const overlaps = (x: number, y: number, w: number, h: number) =>
    placed.some((j) => {
      const p = pos[j]!;
      const o = boxes[j];
      return x < p.x + o.width + gap && p.x < x + w + gap && y < p.y + o.height + gap && p.y < y + h + gap;
    });

  for (let step = 0; step < n; step++) {
    // Next: most links to what's placed, then most links at all, then largest.
    let next = -1;
    let key: [number, number, number] = [-1, -1, -1];
    for (let i = 0; i < n; i++) {
      if (pos[i]) continue;
      const k: [number, number, number] = [ends[i].filter((e) => pos[e.other]).length, ends[i].length, area(i)];
      if (k[0] > key[0] || (k[0] === key[0] && (k[1] > key[1] || (k[1] === key[1] && k[2] > key[2])))) {
        next = i;
        key = k;
      }
    }
    const { width: w, height: h } = boxes[next];
    if (!bbox) {
      pos[next] = { x: 0, y: 0 };
      placed.push(next);
      bbox = { x: 0, y: 0, width: w, height: h };
      continue;
    }

    // Candidate spots: every combination of the edges beside a placed box —
    // left of, right of, flush with either side — and the same vertically.
    const xs = new Set<number>();
    const ys = new Set<number>();
    for (const j of placed) {
      const p = pos[j]!;
      const o = boxes[j];
      xs.add(p.x).add(p.x + o.width - w).add(p.x + o.width + gap).add(p.x - w - gap);
      ys.add(p.y).add(p.y + o.height - h).add(p.y + o.height + gap).add(p.y - h - gap);
    }
    const linked = ends[next].filter((e) => pos[e.other]);
    const before = size(bbox);
    let best: { x: number; y: number; cost: number } | null = null;
    const candidates: Array<{ x: number; y: number; cost: number }> = [];
    for (const x of xs) {
      for (const y of ys) {
        const minX = Math.min(bbox.x, x);
        const minY = Math.min(bbox.y, y);
        const grown = size({
          x: minX,
          y: minY,
          width: Math.max(bbox.x + bbox.width, x + w) - minX,
          height: Math.max(bbox.y + bbox.height, y + h) - minY,
        });
        let dist = 0;
        for (const e of linked) {
          const o = pos[e.other]!;
          dist += Math.abs(x + e.self.x - (o.x + e.at.x)) + Math.abs(y + e.self.y - (o.y + e.at.y));
        }
        candidates.push({ x, y, cost: grown - before + (linked.length ? dist / linked.length : 0) });
      }
    }
    // Cheapest first; ties go to the top-left. Only the cheap ones get the overlap test.
    candidates.sort((a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x);
    for (const c of candidates) {
      if (!overlaps(c.x, c.y, w, h)) {
        best = c;
        break;
      }
    }
    // Something always fits right of everything.
    const spot: PackPoint = best ?? { x: bbox.x + bbox.width + gap, y: bbox.y };
    pos[next] = { x: spot.x, y: spot.y };
    placed.push(next);
    const minX = Math.min(bbox.x, spot.x);
    const minY = Math.min(bbox.y, spot.y);
    bbox = {
      x: minX,
      y: minY,
      width: Math.max(bbox.x + bbox.width, spot.x + w) - minX,
      height: Math.max(bbox.y + bbox.height, spot.y + h) - minY,
    };
  }

  const { x: ox, y: oy } = bbox!;
  return pos.map((p) => ({ x: p!.x - ox + padding, y: p!.y - oy + padding }));
}
