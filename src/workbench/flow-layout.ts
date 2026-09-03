import type { ContentNode } from "../protocol/index.js";

type FlowNode = Extract<ContentNode, { type: "flow" }>;
type FlowEdge = FlowNode["edges"][number];

// Geometry constants. Every value here is layout-local: none of them is part of
// the DES-019/§11.8 visual contract, which fixes the :root palette and the
// 1280/340 page grid, not the internals of a diagram.
const NODE_FONT = 15;
const LABEL_FONT = 13;
const NODE_PAD_X = 18;
const NODE_MAX_TEXT = 218;
const NODE_MIN_W = 120;
const NODE_LINE_H = 19;
const NODE_PAD_Y = 13;
const RANK_GAP = 66;
const COL_GAP = 26;
const MARGIN_X = 14;
const MARGIN_Y = 14;
const LABEL_PAD_X = 5;
const LABEL_H = 17;
const LABEL_MAX_W = 250;
const ELLIPSIS = "\u2026";
const LOOP_W = 38;
export const DECISION_BEVEL = 22;
const ARROW_LEN = 12;
const ARROW_HALF = 6;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacedNode {
  readonly id: string;
  readonly kind: "start" | "step" | "decision" | "end";
  readonly lines: readonly string[];
  /** Centre point. */
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacedLabel {
  /** What the diagram draws; elided when the authored label is over-long. */
  readonly text: string;
  /** The authored label, always carried in full by the text alternative. */
  readonly full: string;
  /** Centre of the label plate. */
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  /** True when no candidate position was free and the least-bad one was used. */
  readonly crowded: boolean;
}

export interface PlacedEdge {
  readonly edge: FlowEdge;
  /** SVG path data. Straight edges are emitted as a two-point path. */
  readonly path: string;
  /** Arrow head polygon points. */
  readonly arrow: string;
  readonly loop: boolean;
  readonly label: PlacedLabel | null;
}

export interface FlowLayout {
  /** SVG viewBox covering every node box, edge path and label plate. */
  readonly viewBox: Rect;
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly PlacedEdge[];
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Deterministic advance-width estimate. The workbench renders offline and the
 * unit-test document stub implements no measurement API, so every geometry
 * decision is arithmetic over code points rather than a layout read.
 */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  );
}

export function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const character of text) {
    units += isWideCodePoint(character.codePointAt(0) ?? 0) ? 1 : 0.56;
  }
  return Math.round(units * fontSize * 100) / 100;
}

/**
 * Wrap a node label onto at most two balanced lines.
 *
 * Both lines are scored by how far the break is from the midpoint. A space gets
 * a bounded bonus rather than an absolute veto: an unconditional "first space
 * wins" rule breaks `A 冷启动：…` after the `A`, leaving one enormous line and a
 * node 80% wider than it needs to be.
 */
const SPACE_BREAK_BONUS = NODE_MAX_TEXT / 4;

function wrapLabel(text: string): string[] {
  if (textWidth(text, NODE_FONT) <= NODE_MAX_TEXT) return [text];
  const characters = [...text];
  const half = textWidth(text, NODE_FONT) / 2;
  let bestIndex = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  let running = 0;
  for (let index = 1; index < characters.length; index += 1) {
    running += textWidth(characters[index - 1] ?? "", NODE_FONT);
    const cost = Math.abs(running - half)
      - (characters[index - 1] === " " ? SPACE_BREAK_BONUS : 0);
    if (cost < bestCost) {
      bestIndex = index;
      bestCost = cost;
    }
  }
  if (bestIndex === 0) return [text];
  const first = characters.slice(0, bestIndex).join("").trim();
  const second = characters.slice(bestIndex).join("").trim();
  // A break that empties either line is worse than not breaking at all.
  if (first === "" || second === "") return [text.trim()];
  return [first, second];
}

/**
 * Classify the edges that close a cycle so the remaining graph can be layered.
 * Iterative depth-first search keeps the traversal independent of call depth
 * and deterministic in `nodes[]` order.
 */
function classifyBackEdges(
  order: readonly string[],
  outgoing: ReadonlyMap<string, readonly { to: string; index: number }[]>,
): Set<number> {
  const back = new Set<number>();
  const state = new Map<string, number>();
  for (const root of order) {
    if ((state.get(root) ?? 0) !== 0) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const edges = outgoing.get(frame.id) ?? [];
      if (frame.next >= edges.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const edge = edges[frame.next];
      frame.next += 1;
      if (!edge) continue;
      const seen = state.get(edge.to) ?? 0;
      if (seen === 1) back.add(edge.index);
      else if (seen === 0) {
        state.set(edge.to, 1);
        stack.push({ id: edge.to, next: 0 });
      }
    }
  }
  return back;
}

/** Longest-path layering over the acyclic remainder. */
function assignRanks(
  order: readonly string[],
  forward: readonly { from: string; to: string }[],
): Map<string, number> {
  const rank = new Map<string, number>();
  for (const id of order) rank.set(id, 0);
  // The forward set is acyclic, so |V| relaxation rounds always converge.
  for (let round = 0; round < order.length; round += 1) {
    let changed = false;
    for (const edge of forward) {
      const next = (rank.get(edge.from) ?? 0) + 1;
      if (next > (rank.get(edge.to) ?? 0)) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

function rectOf(node: PlacedNode): Rect {
  return {
    x: node.cx - node.width / 2,
    y: node.cy - node.height / 2,
    width: node.width,
    height: node.height,
  };
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function containsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/**
 * Liang-Barsky slab clip: does the segment a→b touch the rectangle at all?
 *
 * Sampling points along a path and asking "is this point inside the plate"
 * misses a path that grazes the plate for less than the sample spacing. Testing
 * the segments between samples is exact for the polyline, so the only remaining
 * approximation is the polyline itself.
 */
function segmentHitsRect(a: Point, b: Point, rect: Rect): boolean {
  const deltaX = b.x - a.x;
  const deltaY = b.y - a.y;
  const edges = [-deltaX, deltaX, -deltaY, deltaY];
  const distances = [
    a.x - rect.x,
    rect.x + rect.width - a.x,
    a.y - rect.y,
    rect.y + rect.height - a.y,
  ];
  let enter = 0;
  let exit = 1;
  for (let index = 0; index < 4; index += 1) {
    const edge = edges[index] ?? 0;
    const distance = distances[index] ?? 0;
    if (edge === 0) {
      if (distance < 0) return false;
      continue;
    }
    const t = distance / edge;
    if (edge < 0) {
      if (t > exit) return false;
      if (t > enter) enter = t;
    } else {
      if (t < enter) return false;
      if (t < exit) exit = t;
    }
  }
  return true;
}

function pathHitsRect(points: readonly Point[], rect: Rect): boolean {
  if (points.length === 1) return containsPoint(rect, points[0] as Point);
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a !== undefined && b !== undefined && segmentHitsRect(a, b, rect)) return true;
  }
  return false;
}

/** Clip a ray leaving `centre` at the boundary of an axis-aligned box. */
function boundaryPoint(node: PlacedNode, unitX: number, unitY: number): Point {
  const horizontal = unitX === 0
    ? Number.POSITIVE_INFINITY
    : (node.width / 2 + 3) / Math.abs(unitX);
  const vertical = unitY === 0
    ? Number.POSITIVE_INFINITY
    : (node.height / 2 + 3) / Math.abs(unitY);
  const distance = Math.min(horizontal, vertical);
  return { x: node.cx + unitX * distance, y: node.cy + unitY * distance };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function quadPoint(from: Point, control: Point, to: Point, t: number): Point {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
    y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
  };
}

function quadTangent(from: Point, control: Point, to: Point, t: number): Point {
  const inverse = 1 - t;
  return {
    x: 2 * inverse * (control.x - from.x) + 2 * t * (to.x - control.x),
    y: 2 * inverse * (control.y - from.y) + 2 * t * (to.y - control.y),
  };
}

function normalize(vector: Point): Point {
  const length = Math.hypot(vector.x, vector.y);
  return length === 0 ? { x: 1, y: 0 } : { x: vector.x / length, y: vector.y / length };
}

interface EdgeGeometry {
  readonly path: string;
  readonly arrow: string;
  readonly loop: boolean;
  readonly at: (t: number) => Point;
  readonly normalAt: (t: number) => Point;
  readonly samples: readonly Point[];
}

function arrowPoints(tip: Point, direction: Point): string {
  const baseX = tip.x - direction.x * ARROW_LEN;
  const baseY = tip.y - direction.y * ARROW_LEN;
  const perpendicularX = -direction.y * ARROW_HALF;
  const perpendicularY = direction.x * ARROW_HALF;
  return `${round(tip.x)},${round(tip.y)} `
    + `${round(baseX + perpendicularX)},${round(baseY + perpendicularY)} `
    + `${round(baseX - perpendicularX)},${round(baseY - perpendicularY)}`;
}

function cubicPoint(from: Point, c1: Point, c2: Point, to: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
    y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
  };
}

/**
 * Sample a curve densely enough that a label plate cannot slip between two
 * consecutive points. A fixed count leaves ~48px gaps on a long back edge,
 * which is wider than the 17px plate, so an opaque plate could erase an edge
 * while every collision probe reported clear.
 */
const SAMPLE_STEP = 6;
const MAX_SAMPLES = 96;

function samplePath(hull: readonly Point[], at: (t: number) => Point): Point[] {
  let span = 0;
  for (let index = 1; index < hull.length; index += 1) {
    const a = hull[index - 1] as Point;
    const b = hull[index] as Point;
    span += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const steps = Math.max(8, Math.min(MAX_SAMPLES, Math.ceil(span / SAMPLE_STEP)));
  const points: Point[] = [];
  for (let step = 0; step <= steps; step += 1) points.push(at(step / steps));
  return points;
}

function sampleCubic(from: Point, c1: Point, c2: Point, to: Point): Point[] {
  return samplePath([from, c1, c2, to], (t) => cubicPoint(from, c1, c2, to, t));
}

function sampleQuad(from: Point, control: Point, to: Point): Point[] {
  return samplePath([from, control, to], (t) => quadPoint(from, control, to, t));
}

/**
 * Self-edge: a closed arc hung off the node's right flank, in space the rank
 * pass reserved for it. `spread` fans repeated self-edges on one node apart.
 */
function loopGeometry(node: PlacedNode, index: number, offset: number): EdgeGeometry {
  const right = node.cx + node.width / 2;
  const top = node.cy - node.height / 4;
  const bottom = node.cy + node.height / 4;
  const width = LOOP_W + index * 14;
  const control = right + width;
  const start = { x: right, y: top };
  const end = { x: right, y: bottom };
  const path = `M ${round(right)} ${round(top)} `
    + `C ${round(control)} ${round(top - 12)}, ${round(control)} ${round(bottom + 12)}, `
    + `${round(right)} ${round(bottom)}`;
  // A cubic with both controls at x=control reaches 0.75 of the way there, so
  // the drawn arc ends well short of the control point. Anchor the label past
  // the *drawn* extent, not past the control, or the plate covers the loop.
  const extent = right + width * 0.75;
  const samples = sampleCubic(
    start,
    { x: control, y: top - 12 },
    { x: control, y: bottom + 12 },
    end,
  );
  // Repeated loops on one node stack vertically as well as outward: a purely
  // horizontal anchor gives every loop label the same y and they collide.
  const anchor = { x: extent, y: node.cy + offset };
  // The cubic's end tangent is 3*(P3-P2) = (-(width), -12); a hard-coded
  // direction sat up to 46 degrees off the curve it terminates.
  const endDirection = normalize({ x: -width, y: -12 });
  return {
    path,
    arrow: arrowPoints(end, endDirection),
    loop: true,
    at: () => anchor,
    normalAt: () => ({ x: 1, y: 0 }),
    samples,
  };
}

function straightGeometry(from: Point, to: Point): EdgeGeometry {
  const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  return {
    ...explicitQuad(from, midpoint, to),
    path: `M ${round(from.x)} ${round(from.y)} L ${round(to.x)} ${round(to.y)}`,
  };
}

function explicitQuad(from: Point, control: Point, to: Point): EdgeGeometry {
  const endDirection = normalize(quadTangent(from, control, to, 1));
  return {
    path: `M ${round(from.x)} ${round(from.y)} `
      + `Q ${round(control.x)} ${round(control.y)}, ${round(to.x)} ${round(to.y)}`,
    arrow: arrowPoints(to, endDirection),
    loop: false,
    at: (t) => quadPoint(from, control, to, t),
    normalAt: (t) => {
      const tangent = normalize(quadTangent(from, control, to, t));
      return { x: -tangent.y, y: tangent.x };
    },
    samples: sampleQuad(from, control, to),
  };
}

function curvedGeometry(from: Point, to: Point, bow: number): EdgeGeometry {
  const direction = normalize({ x: to.x - from.x, y: to.y - from.y });
  return explicitQuad(from, {
    x: (from.x + to.x) / 2 - direction.y * bow,
    y: (from.y + to.y) / 2 + direction.x * bow,
  }, to);
}

/**
 * An edge label may be arbitrarily long, and one wider than the diagram cannot
 * be placed anywhere without covering it. The picture shows an elided label;
 * the text alternative keeps the authored string in full.
 */
function fitLabel(text: string): { display: string; width: number } {
  const natural = textWidth(text, LABEL_FONT) + LABEL_PAD_X * 2;
  if (natural <= LABEL_MAX_W) return { display: text, width: natural };
  const ellipsis = textWidth(ELLIPSIS, LABEL_FONT);
  const budget = LABEL_MAX_W - LABEL_PAD_X * 2 - ellipsis;
  let used = 0;
  let kept = "";
  for (const character of text) {
    const advance = textWidth(character, LABEL_FONT);
    if (used + advance > budget) break;
    used += advance;
    kept += character;
  }
  return { display: `${kept}${ELLIPSIS}`, width: used + ellipsis + LABEL_PAD_X * 2 };
}

const LABEL_STOPS = [0.5, 0.38, 0.62, 0.28, 0.72] as const;
const LABEL_SIDES = [1, -1] as const;
const LABEL_REACH = [LABEL_H / 2 + 5, LABEL_H / 2 + 20, LABEL_H / 2 + 35] as const;
// A wide plate needs to clear the column, not just the line it belongs to.
function reachesFor(width: number): number[] {
  return [...LABEL_REACH, width / 2 + 24, width / 2 + 56];
}

/**
 * Place an edge label beside its own path, clear of node boxes, other labels
 * and other edge paths. The search is exhaustive over a fixed candidate set and
 * falls back to the least-overlapping position, so placement is deterministic.
 */
function placeLabel(
  text: string,
  geometry: EdgeGeometry,
  occupied: readonly Rect[],
  obstacles: readonly (readonly Point[])[],
): PlacedLabel {
  const fitted = fitLabel(text);
  const width = fitted.width;
  let best: { rect: Rect; cost: number } | null = null;
  for (const reach of reachesFor(width)) {
    for (const stop of LABEL_STOPS) {
      for (const side of LABEL_SIDES) {
        const anchor = geometry.at(stop);
        const normal = geometry.normalAt(stop);
        const cx = anchor.x + normal.x * reach * side;
        const cy = anchor.y + normal.y * reach * side;
        const rect: Rect = { x: cx - width / 2, y: cy - LABEL_H / 2, width, height: LABEL_H };
        let cost = 0;
        for (const other of occupied) cost += overlapArea(rect, other);
        for (const path of obstacles) if (pathHitsRect(path, rect)) cost += 240;
        if (cost === 0) {
          return {
            text: fitted.display,
            full: text,
            cx: round(cx),
            cy: round(cy),
            width,
            height: LABEL_H,
            crowded: false,
          };
        }
        if (!best || cost < best.cost) best = { rect, cost };
      }
    }
  }
  const rect = best?.rect ?? { x: 0, y: 0, width, height: LABEL_H };
  return {
    text: fitted.display,
    full: text,
    cx: round(rect.x + width / 2),
    cy: round(rect.y + LABEL_H / 2),
    width,
    height: LABEL_H,
    crowded: true,
  };
}

/**
 * `edgeLabel` lets the caller widen an edge's drawn text — an edge that carries
 * only a `kind` still deserves a visible "yes"/"no" on the picture.
 */
export function layoutFlow(
  flow: FlowNode,
  edgeLabel: (edge: FlowEdge) => string | undefined = (edge) => edge.label,
): FlowLayout {
  const order = flow.nodes.map((node) => node.id);
  const known = new Set(order);
  for (const edge of flow.edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) throw new Error("FLOW_REFERENCE_INVALID");
  }

  const outgoing = new Map<string, { to: string; index: number }[]>();
  for (const id of order) outgoing.set(id, []);
  flow.edges.forEach((edge, index) => {
    if (edge.from === edge.to) return;
    outgoing.get(edge.from)?.push({ to: edge.to, index });
  });

  const back = classifyBackEdges(order, outgoing);
  const forward = flow.edges
    .map((edge, index) => ({ from: edge.from, to: edge.to, index }))
    .filter((edge) => edge.from !== edge.to && !back.has(edge.index));
  const rank = assignRanks(order, forward);

  // Order within each rank by the mean position of already-placed predecessors,
  // tie-broken by authored order, which cuts crossings without a full sweep.
  const byRank = new Map<number, string[]>();
  for (const id of order) {
    const value = rank.get(id) ?? 0;
    const bucket = byRank.get(value);
    if (bucket) bucket.push(id);
    else byRank.set(value, [id]);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const positionInRank = new Map<string, number>();
  for (const value of ranks) {
    const bucket = byRank.get(value) ?? [];
    const scored = bucket.map((id, index) => {
      const parents = forward.filter((edge) => edge.to === id);
      const known2 = parents
        .map((edge) => positionInRank.get(edge.from))
        .filter((slot): slot is number => slot !== undefined);
      const barycentre = known2.length === 0
        ? index
        : known2.reduce((sum, slot) => sum + slot, 0) / known2.length;
      return { id, index, barycentre };
    });
    scored.sort((a, b) => a.barycentre - b.barycentre || a.index - b.index);
    byRank.set(value, scored.map((entry) => entry.id));
    scored.forEach((entry, slot) => positionInRank.set(entry.id, slot));
  }

  // A self-edge needs room for its arc *and* its label, or the label search has
  // nowhere to go but on top of the next node in the rank. Two details matter:
  // the reserved width must be measured from the string the renderer actually
  // draws — an edge carrying only a `kind` still gets a label — and from the
  // elided width, since `fitLabel` caps a plate at LABEL_MAX_W.
  const loopReserve = new Map<string, number>();
  const loopSlots = new Map<string, number>();
  for (const edge of flow.edges) {
    if (edge.from !== edge.to) continue;
    const slot = loopSlots.get(edge.from) ?? 0;
    loopSlots.set(edge.from, slot + 1);
    const drawn = edgeLabel(edge);
    const labelRoom = drawn === undefined || drawn === ""
      ? 0
      : fitLabel(drawn).width + LABEL_REACH[0] + 12;
    // Widest single loop wins the horizontal budget; the arcs themselves fan
    // outward by 14 each, and the labels stack vertically rather than sideways.
    const need = LOOP_W + slot * 14 + labelRoom;
    loopReserve.set(edge.from, Math.max(loopReserve.get(edge.from) ?? 0, need));
  }
  const shape = new Map<
    string,
    { kind: PlacedNode["kind"]; lines: string[]; width: number; height: number }
  >();
  for (const node of flow.nodes) {
    const lines = wrapLabel(node.label);
    const widest = Math.max(...lines.map((line) => textWidth(line, NODE_FONT)));
    const kind = node.kind ?? "step";
    // A hexagon loses horizontal room to its bevels; give the text that back.
    const bevel = kind === "decision" ? DECISION_BEVEL * 2 : 0;
    shape.set(node.id, {
      kind,
      lines,
      width: Math.max(NODE_MIN_W, Math.ceil(widest) + NODE_PAD_X * 2 + bevel),
      height: lines.length * NODE_LINE_H + NODE_PAD_Y * 2,
    });
  }

  const rankWidth = new Map<number, number>();
  const rankHeight = new Map<number, number>();
  for (const value of ranks) {
    const bucket = byRank.get(value) ?? [];
    let width = 0;
    let height = 0;
    bucket.forEach((id, index) => {
      const box = shape.get(id);
      if (!box) return;
      width += box.width + (loopReserve.get(id) ?? 0);
      if (index > 0) width += COL_GAP;
      height = Math.max(height, box.height);
    });
    rankWidth.set(value, width);
    rankHeight.set(value, height);
  }

  const contentWidth = Math.max(...[...rankWidth.values()], NODE_MIN_W);
  const width = Math.ceil(contentWidth + MARGIN_X * 2);

  const placedNodes: PlacedNode[] = [];
  let cursorY = MARGIN_Y;
  for (const value of ranks) {
    const bucket = byRank.get(value) ?? [];
    const rowHeight = rankHeight.get(value) ?? 0;
    let cursorX = MARGIN_X + (contentWidth - (rankWidth.get(value) ?? 0)) / 2;
    for (const id of bucket) {
      const box = shape.get(id);
      if (!box) continue;
      placedNodes.push({
        id,
        kind: box.kind,
        lines: box.lines,
        cx: round(cursorX + box.width / 2),
        cy: round(cursorY + rowHeight / 2),
        width: box.width,
        height: box.height,
      });
      cursorX += box.width + (loopReserve.get(id) ?? 0) + COL_GAP;
    }
    cursorY += rowHeight + RANK_GAP;
  }
  const height = Math.max(MARGIN_Y * 2, Math.ceil(cursorY - RANK_GAP + MARGIN_Y));

  const nodeById = new Map(placedNodes.map((node) => [node.id, node]));
  const nodeRects = placedNodes.map(rectOf);

  // Fan duplicate and reciprocal edges apart so their paths — and therefore
  // their label anchors — can never coincide.
  const pairCount = new Map<string, number>();
  const pairSeen = new Map<string, number>();
  for (const edge of flow.edges) {
    if (edge.from === edge.to) continue;
    const key = edge.from < edge.to ? `${edge.from} ${edge.to}` : `${edge.to} ${edge.from}`;
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }

  const columnLeft = Math.min(...nodeRects.map((rect) => rect.x));
  const columnRight = Math.max(...nodeRects.map((rect) => rect.x + rect.width));
  const loopRight = Math.max(
    columnRight,
    ...placedNodes.map((node) => node.cx + node.width / 2 + (loopReserve.get(node.id) ?? 0)),
  );
  let leftLane = 0;
  let rightLane = 0;

  const geometries: EdgeGeometry[] = [];
  const loopDrawn = new Map<string, number>();
  for (const edge of flow.edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) throw new Error("FLOW_REFERENCE_INVALID");
    if (edge.from === edge.to) {
      const index = loopDrawn.get(edge.from) ?? 0;
      loopDrawn.set(edge.from, index + 1);
      const total = loopSlots.get(edge.from) ?? 1;
      // Centre the stack on the node: offsets -h, 0, +h … for 1, 2, 3 loops.
      const offset = (index - (total - 1) / 2) * (LABEL_H + 6);
      geometries.push(loopGeometry(from, index, offset));
      continue;
    }
    const key = edge.from < edge.to ? `${edge.from} ${edge.to}` : `${edge.to} ${edge.from}`;
    const total = pairCount.get(key) ?? 1;
    const seen = pairSeen.get(key) ?? 0;
    pairSeen.set(key, seen + 1);
    const span = (rank.get(edge.to) ?? 0) - (rank.get(edge.from) ?? 0);

    // An edge that skips a rank, returns upwards, or stays inside one rank must
    // not be drawn through the node column: a straight run there threads between
    // the boxes and reads as if it joined the neighbours it passes.
    if (span > 1 || span <= 0) {
      const goLeft = span <= 0;
      const lane = goLeft ? leftLane++ : rightLane++;
      const side = goLeft ? -1 : 1;
      const face = goLeft
        ? { x: -1, y: 0 } as const
        : { x: 1, y: 0 } as const;
      const start = boundaryPoint(from, face.x, face.y);
      const end = boundaryPoint(to, face.x, face.y);
      const wall = goLeft ? columnLeft : loopRight;
      const excursion = wall + side * (34 + lane * 26);
      const control = {
        x: 2 * excursion - 0.5 * (start.x + end.x),
        y: (start.y + end.y) / 2,
      };
      geometries.push(explicitQuad(start, control, end));
      continue;
    }

    const unit = normalize({ x: to.cx - from.cx, y: to.cy - from.cy });
    const start = boundaryPoint(from, unit.x, unit.y);
    const end = boundaryPoint(to, -unit.x, -unit.y);
    // One offset per parallel edge, alternating sides around the straight line.
    let bow = total > 1 ? (Math.floor(seen / 2) + 1) * 22 * (seen % 2 === 0 ? 1 : -1) : 0;
    if (bow === 0) {
      // A straight run that crosses an unrelated node box gets bowed clear.
      const straight = straightGeometry(start, end);
      const blocking = nodeRects.filter((rect, index) => {
        const node = placedNodes[index];
        if (!node || node.id === edge.from || node.id === edge.to) return false;
        return straight.samples.some((point) => containsPoint(rect, point));
      });
      if (blocking.length === 0) {
        geometries.push(straight);
        continue;
      }
      bow = 46;
    }
    geometries.push(curvedGeometry(start, end, bow));
  }

  const occupied: Rect[] = [...nodeRects];
  const placedEdges: PlacedEdge[] = [];
  flow.edges.forEach((edge, index) => {
    const geometry = geometries[index];
    if (!geometry) return;
    let label: PlacedLabel | null = null;
    const text = edgeLabel(edge);
    if (text !== undefined && text !== "") {
      // A normal edge's plate straddles its own line — that is the conventional
      // rendering. A loop's plate sits beside a closed arc, so the arc counts as
      // an obstacle for it; otherwise a long loop label covers the loop it names.
      const obstacles = geometries
        .filter((_, other) => other !== index || geometry.loop)
        .map((other) => other.samples);
      label = placeLabel(text, geometry, occupied, obstacles);
      occupied.push({
        x: label.cx - label.width / 2,
        y: label.cy - label.height / 2,
        width: label.width,
        height: label.height,
      });
    }
    placedEdges.push({
      edge,
      path: geometry.path,
      arrow: geometry.arrow,
      loop: geometry.loop,
      label,
    });
  });

  // Bowed edges and outward labels reach past the node grid, so the canvas is
  // measured from the finished geometry instead of the grid it started from.
  let minX = 0;
  let minY = 0;
  let maxX = width;
  let maxY = height;
  const cover = (rect: Rect): void => {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  };
  for (const rect of occupied) cover(rect);
  for (const geometry of geometries) {
    for (const point of geometry.samples) {
      cover({ x: point.x - 2, y: point.y - 2, width: 4, height: 4 });
    }
  }
  const viewBox: Rect = {
    x: round(minX - MARGIN_X),
    y: round(minY - MARGIN_Y),
    width: round(maxX - minX + MARGIN_X * 2),
    height: round(maxY - minY + MARGIN_Y * 2),
  };

  return { viewBox, nodes: placedNodes, edges: placedEdges };
}
