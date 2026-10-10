// Right-angle routes around the cards for the edges ELK didn't lay out: the
// app map's weaker links, shown dashed only while their card is selected.
// Selection never re-runs the layout (it would move every card), so those
// edges are routed here, against the cards where ELK put them.
//
// A grid search on the lines just outside each card (and the middles between
// them): a route runs along those lines, never through a card, and bends as
// little as it can.

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

/** How far a route keeps from a card. */
const CLEARANCE = 14;
/** Length of the straight stub out of the source and into the target. */
const STUB = 24;
/** One bend costs as much as this much extra length. */
const BEND_COST = 60;
/** Running along a stretch another route already uses costs this much extra. */
const SHARED_COST = 80;

type Dir = 0 | 1 | 2 | 3; // right, down, left, up
const STEP: Record<Dir, [number, number]> = { 0: [1, 0], 1: [0, 1], 2: [-1, 0], 3: [0, -1] };

/** A min-heap keyed by cost. */
class Heap {
  private items: Array<{ cost: number; state: number }> = [];
  get size() {
    return this.items.length;
  }
  push(cost: number, state: number) {
    const a = this.items;
    a.push({ cost, state });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function sortedUnique(values: number[]): number[] {
  const out = [...new Set(values.map((v) => Math.round(v * 2) / 2))].sort((a, b) => a - b);
  // Corridors between neighbouring lines, so parallel routes have somewhere to run.
  const mids: number[] = [];
  for (let i = 1; i < out.length; i++) if (out[i] - out[i - 1] > 2 * CLEARANCE) mids.push((out[i] + out[i - 1]) / 2);
  return [...new Set([...out, ...mids])].sort((a, b) => a - b);
}

/** Strictly inside the box grown by `CLEARANCE` (its border lines are free to run along). */
function inside(boxes: Box[], x: number, y: number): boolean {
  for (const b of boxes) {
    if (x > b.x - CLEARANCE && x < b.x + b.width + CLEARANCE && y > b.y - CLEARANCE && y < b.y + b.height + CLEARANCE) return true;
  }
  return false;
}

/** One grid stretch, either way round. */
function segmentKey(x1: number, y1: number, x2: number, y2: number): string {
  return x1 < x2 || (x1 === x2 && y1 < y2) ? `${x1},${y1},${x2},${y2}` : `${x2},${y2},${x1},${y1}`;
}

/** Drops the points where the route doesn't turn. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length > 0 && out[out.length - 1].x === p.x && out[out.length - 1].y === p.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) out.pop();
    }
    out.push(p);
  }
  return out;
}

/**
 * A route from `start` (on the source card's right side) to `end` (on the
 * target card's left side) that keeps clear of every box, or `null` when the
 * boxes leave no way through.
 */
export function routeAround(start: Point, end: Point, boxes: Box[], used: Set<string> = new Set()): Point[] | null {
  const from = { x: start.x + STUB, y: start.y };
  const to = { x: end.x - STUB, y: end.y };
  const xEdges = [from.x, to.x, ...boxes.flatMap((b) => [b.x - CLEARANCE, b.x + b.width + CLEARANCE])];
  const yEdges = [from.y, to.y, ...boxes.flatMap((b) => [b.y - CLEARANCE, b.y + b.height + CLEARANCE])];
  // A frame outside everything, so a route can always go round the outside.
  const xs = sortedUnique([...xEdges, Math.min(...xEdges) - STUB, Math.max(...xEdges) + STUB]);
  const ys = sortedUnique([...yEdges, Math.min(...yEdges) - STUB, Math.max(...yEdges) + STUB]);
  const W = xs.length;
  const H = ys.length;
  const fi = xs.indexOf(Math.round(from.x * 2) / 2);
  const fj = ys.indexOf(Math.round(from.y * 2) / 2);
  const ti = xs.indexOf(Math.round(to.x * 2) / 2);
  const tj = ys.indexOf(Math.round(to.y * 2) / 2);
  if (fi < 0 || fj < 0 || ti < 0 || tj < 0) return null;

  const free = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) free[j * W + i] = inside(boxes, xs[i], ys[j]) ? 0 : 1;
  // The stub ends sit just outside their cards; never block them.
  free[fj * W + fi] = 1;
  free[tj * W + ti] = 1;
  /** The segment between two neighbouring grid points stays outside every box. */
  const open = (i1: number, j1: number, i2: number, j2: number) => !inside(boxes, (xs[i1] + xs[i2]) / 2, (ys[j1] + ys[j2]) / 2);

  const state = (i: number, j: number, d: Dir) => (j * W + i) * 4 + d;
  const cost = new Float64Array(W * H * 4).fill(Infinity);
  const prev = new Int32Array(W * H * 4).fill(-1);
  const heap = new Heap();
  // Leaves the source heading right.
  const s0 = state(fi, fj, 0);
  cost[s0] = 0;
  heap.push(0, s0);
  let goal = -1;
  while (heap.size > 0) {
    const { cost: c, state: s } = heap.pop();
    if (c > cost[s]) continue;
    const d = (s % 4) as Dir;
    const cell = (s - d) / 4;
    const i = cell % W;
    const j = (cell - i) / W;
    // Arrives heading right, into the target's left side.
    if (i === ti && j === tj && d === 0) {
      goal = s;
      break;
    }
    for (const nd of [0, 1, 2, 3] as Dir[]) {
      if ((nd + 2) % 4 === d) continue; // no U-turns
      const ni = i + STEP[nd][0];
      const nj = j + STEP[nd][1];
      if (ni < 0 || nj < 0 || ni >= W || nj >= H || !free[nj * W + ni] || !open(i, j, ni, nj)) continue;
      const shared = used.has(segmentKey(xs[i], ys[j], xs[ni], ys[nj])) ? SHARED_COST : 0;
      const nc = c + Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (nd === d ? 0 : BEND_COST) + shared;
      const ns = state(ni, nj, nd);
      if (nc < cost[ns]) {
        cost[ns] = nc;
        prev[ns] = s;
        heap.push(nc, ns);
      }
    }
  }
  if (goal < 0) return null;
  const path: Point[] = [];
  for (let s = goal; s >= 0; s = prev[s]) {
    const cell = (s - (s % 4)) / 4;
    const i = cell % W;
    path.push({ x: xs[i], y: ys[(cell - i) / W] });
  }
  path.reverse();
  for (let k = 1; k < path.length; k++) used.add(segmentKey(path[k - 1].x, path[k - 1].y, path[k].x, path[k].y));
  return simplify([start, ...path, end]);
}

/**
 * Routes for links between laid-out cards, spreading each card's ends along
 * its side so routes leaving the same card don't share one point.
 */
export function routeLinks(
  links: ReadonlyArray<{ id: string; source: string; target: string }>,
  cards: ReadonlyMap<string, Box>
): Map<string, Point[]> {
  const out = new Map<string, Point[]>();
  const boxes = [...cards.values()];
  const used = new Set<string>();
  const outs = new Map<string, string[]>();
  const ins = new Map<string, string[]>();
  for (const l of links) {
    if (!cards.has(l.source) || !cards.has(l.target)) continue;
    outs.set(l.source, [...(outs.get(l.source) ?? []), l.id]);
    ins.set(l.target, [...(ins.get(l.target) ?? []), l.id]);
  }
  /** The n-th of `count` points down a card's side, away from its middle (where ELK's edges tend to land). */
  const along = (box: Box, index: number, count: number) => box.y + (box.height * (index + 1)) / (count + 1) + (count === 1 ? box.height / 6 : 0);
  for (const l of links) {
    const a = cards.get(l.source);
    const b = cards.get(l.target);
    if (!a || !b) continue;
    const so = outs.get(l.source)!;
    const ti = ins.get(l.target)!;
    const start = { x: a.x + a.width, y: Math.round(along(a, so.indexOf(l.id), so.length)) };
    const end = { x: b.x, y: Math.round(along(b, ti.indexOf(l.id), ti.length)) };
    const route = routeAround(start, end, boxes, used);
    if (route) out.set(l.id, route);
  }
  return out;
}
