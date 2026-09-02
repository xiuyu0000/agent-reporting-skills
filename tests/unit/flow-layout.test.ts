import { describe, expect, it } from "vitest";
import type { ContentNode } from "../../src/protocol/index.js";
import { layoutFlow, textWidth, type FlowLayout, type Rect } from "../../src/workbench/flow-layout.js";

type FlowNode = Extract<ContentNode, { type: "flow" }>;

function flow(
  nodes: readonly { id: string; label: string }[],
  edges: readonly { from: string; to: string; label?: string }[],
): FlowNode {
  return {
    type: "flow",
    title: "Flow",
    description: "Layout fixture",
    nodes: [...nodes],
    edges: edges.map((edge) => (edge.label === undefined
      ? { from: edge.from, to: edge.to }
      : { from: edge.from, to: edge.to, label: edge.label })),
  };
}

function nodeRects(layout: FlowLayout): Rect[] {
  return layout.nodes.map((node) => ({
    x: node.cx - node.width / 2,
    y: node.cy - node.height / 2,
    width: node.width,
    height: node.height,
  }));
}

function labelRects(layout: FlowLayout): { rect: Rect; text: string }[] {
  return layout.edges
    .filter((edge) => edge.label !== null)
    .map((edge) => {
      const label = edge.label as NonNullable<typeof edge.label>;
      return {
        text: label.text,
        rect: {
          x: label.cx - label.width / 2,
          y: label.cy - label.height / 2,
          width: label.width,
          height: label.height,
        },
      };
    });
}


/** Re-sample an edge path from its SVG data, independently of the layout's own sampling. */
function pathPoints(path: string): { x: number; y: number }[] {
  const numbers = (path.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);
  const points: { x: number; y: number }[] = [];
  const at = (a: number[], b: number[], c: number[], t: number): { x: number; y: number } => ({
    x: (1 - t) * (1 - t) * (a[0] ?? 0) + 2 * (1 - t) * t * (b[0] ?? 0) + t * t * (c[0] ?? 0),
    y: (1 - t) * (1 - t) * (a[1] ?? 0) + 2 * (1 - t) * t * (b[1] ?? 0) + t * t * (c[1] ?? 0),
  });
  const cubic = (a: number[], b: number[], c: number[], d: number[], t: number): { x: number; y: number } => {
    const u = 1 - t;
    return {
      x: u * u * u * (a[0] ?? 0) + 3 * u * u * t * (b[0] ?? 0) + 3 * u * t * t * (c[0] ?? 0) + t * t * t * (d[0] ?? 0),
      y: u * u * u * (a[1] ?? 0) + 3 * u * u * t * (b[1] ?? 0) + 3 * u * t * t * (c[1] ?? 0) + t * t * t * (d[1] ?? 0),
    };
  };
  const STEPS = 400;
  if (path.includes(" C ") && numbers.length >= 8) {
    for (let i = 0; i <= STEPS; i += 1) {
      points.push(cubic(numbers.slice(0, 2), numbers.slice(2, 4), numbers.slice(4, 6), numbers.slice(6, 8), i / STEPS));
    }
  } else if (path.includes(" Q ") && numbers.length >= 6) {
    for (let i = 0; i <= STEPS; i += 1) {
      points.push(at(numbers.slice(0, 2), numbers.slice(2, 4), numbers.slice(4, 6), i / STEPS));
    }
  } else if (numbers.length >= 4) {
    for (let i = 0; i <= STEPS; i += 1) {
      const t = i / STEPS;
      points.push({
        x: (numbers[0] ?? 0) + ((numbers[2] ?? 0) - (numbers[0] ?? 0)) * t,
        y: (numbers[1] ?? 0) + ((numbers[3] ?? 0) - (numbers[1] ?? 0)) * t,
      });
    }
  }
  return points;
}

function inside(rect: Rect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}

function describeOverlap(a: { text: string }, b: { text: string }): string {
  return `"${a.text}" overlaps "${b.text}"`;
}

/** The realistic case the user reported: six stages, a gate, a loop and a cycle. */
const REPORTED = flow(
  [
    { id: "A", label: "A 冷启动：地基+文档集" },
    { id: "B", label: "B 调研收敛循环" },
    { id: "C", label: "C 契约化 spec" },
    { id: "D", label: "D 设计+测试方案+计划" },
    { id: "E", label: "E 里程碑执行循环" },
    { id: "F", label: "F 总收敛与复盘" },
    { id: "G", label: "决策门（轻/重分流）" },
  ],
  [
    { from: "A", to: "B" },
    { from: "B", to: "C", label: "收敛判据通过" },
    { from: "C", to: "D", label: "门 2" },
    { from: "D", to: "E", label: "重量/复杂域" },
    { from: "E", to: "B", label: "缺口回灌" },
    { from: "E", to: "F", label: "收敛契约终态" },
    { from: "G", to: "E", label: "轻量直入" },
    { from: "E", to: "E", label: "里程碑迭代" },
  ],
);

const CASES: readonly { name: string; node: FlowNode }[] = [
  { name: "reported seven-stage flow", node: REPORTED },
  {
    name: "reciprocal pair",
    node: flow(
      [{ id: "A", label: "Alpha" }, { id: "B", label: "Beta" }],
      [{ from: "A", to: "B", label: "forward" }, { from: "B", to: "A", label: "reverse" }],
    ),
  },
  {
    name: "duplicate edges between the same pair",
    node: flow(
      [{ id: "A", label: "Gate" }, { id: "B", label: "Outcome" }],
      [{ from: "A", to: "B", label: "yes" }, { from: "A", to: "B", label: "no" }],
    ),
  },
  {
    name: "rank-skipping bypass edge",
    node: flow(
      [
        { id: "A", label: "One" },
        { id: "B", label: "Two" },
        { id: "C", label: "Three" },
        { id: "D", label: "Four" },
      ],
      [
        { from: "A", to: "B", label: "step" },
        { from: "B", to: "C", label: "step" },
        { from: "C", to: "D", label: "step" },
        { from: "A", to: "D", label: "bypass" },
      ],
    ),
  },
  {
    name: "two self loops in one rank",
    node: flow(
      [{ id: "A", label: "Left" }, { id: "B", label: "Right" }, { id: "S", label: "Source" }],
      [
        { from: "S", to: "A" },
        { from: "S", to: "B" },
        { from: "A", to: "A", label: "retry left" },
        { from: "B", to: "B", label: "retry right" },
      ],
    ),
  },
  {
    name: "long CJK labels",
    node: flow(
      [
        { id: "A", label: "阶段一：把口头约定固化为可校验的结构约定与门禁" },
        { id: "B", label: "阶段二：把门禁接进持续集成并对历史契约做无损重放" },
      ],
      [{ from: "A", to: "B", label: "全部阻断级检查通过后才允许合并" }],
    ),
  },
  {
    name: "pure cycle with no source",
    node: flow(
      [{ id: "A", label: "One" }, { id: "B", label: "Two" }, { id: "C", label: "Three" }],
      [
        { from: "A", to: "B", label: "a" },
        { from: "B", to: "C", label: "b" },
        { from: "C", to: "A", label: "c" },
      ],
    ),
  },
  {
    name: "single node",
    node: flow([{ id: "A", label: "Only" }], []),
  },
  {
    name: "two labelled self loops on one node",
    node: flow(
      [{ id: "A", label: "Review" }, { id: "B", label: "Ship" }],
      [
        { from: "A", to: "B" },
        { from: "A", to: "A", label: "approve after review" },
        { from: "A", to: "A", label: "escalate to owner" },
      ],
    ),
  },
];

/**
 * The renderer resolves an edge's drawn text from `kind` as well as `label`
 * (src/workbench/flow-renderer.ts). Layout must budget for the resolved string:
 * an edge carrying only a `kind` still gets a plate.
 */
const KIND_RESOLVER = (edge: { label?: string; kind?: string }): string | undefined => {
  const word = edge.kind === undefined
    ? undefined
    : ({ yes: "yes", no: "no", else: "otherwise", then: "then" } as const)[
      edge.kind as "yes" | "no" | "else" | "then"
    ];
  if (edge.label === undefined) return word;
  return word === undefined ? edge.label : `${word} · ${edge.label}`;
};

const RESOLVED_CASES: readonly { name: string; node: FlowNode }[] = [
  {
    name: "self loop labelled only by kind",
    node: {
      type: "flow",
      title: "Gate",
      description: "d",
      nodes: [
        { id: "S", label: "Start", kind: "start" },
        { id: "A", label: "Decide", kind: "decision" },
        { id: "B", label: "Done", kind: "end" },
      ],
      edges: [
        { from: "S", to: "A" },
        { from: "S", to: "B" },
        { from: "A", to: "A", kind: "else" },
      ],
    } as FlowNode,
  },
  {
    name: "self loop with both kind and label",
    node: {
      type: "flow",
      title: "Gate",
      description: "d",
      nodes: [{ id: "A", label: "Decide", kind: "decision" }, { id: "B", label: "Done" }],
      edges: [
        { from: "A", to: "B" },
        { from: "A", to: "A", kind: "else", label: "the gate failed" },
      ],
    } as FlowNode,
  },
];

describe("flow layout geometry", () => {
  for (const { name, node } of CASES) {
    describe(name, () => {
      const layout = layoutFlow(node);

      it("keeps every node box clear of every other node box", () => {
        const rects = nodeRects(layout);
        for (let i = 0; i < rects.length; i += 1) {
          for (let j = i + 1; j < rects.length; j += 1) {
            const a = rects[i];
            const b = rects[j];
            if (!a || !b) continue;
            expect(
              overlaps(a, b),
              `${layout.nodes[i]?.id} overlaps ${layout.nodes[j]?.id}`,
            ).toBe(false);
          }
        }
      });

      it("keeps every edge label clear of every other edge label", () => {
        const labels = labelRects(layout);
        for (let i = 0; i < labels.length; i += 1) {
          for (let j = i + 1; j < labels.length; j += 1) {
            const a = labels[i];
            const b = labels[j];
            if (!a || !b) continue;
            expect(overlaps(a.rect, b.rect), describeOverlap(a, b)).toBe(false);
          }
        }
      });

      it("keeps every edge label off every node box", () => {
        const nodes = nodeRects(layout);
        for (const label of labelRects(layout)) {
          for (const [index, rect] of nodes.entries()) {
            expect(
              overlaps(label.rect, rect),
              `"${label.text}" sits on node ${layout.nodes[index]?.id}`,
            ).toBe(false);
          }
        }
      });

      it("never places a label outside the canvas", () => {
        const box = layout.viewBox;
        for (const label of labelRects(layout)) {
          expect(label.rect.x, `"${label.text}" left edge`).toBeGreaterThanOrEqual(box.x);
          expect(label.rect.y, `"${label.text}" top edge`).toBeGreaterThanOrEqual(box.y);
          expect(label.rect.x + label.rect.width, `"${label.text}" right edge`)
            .toBeLessThanOrEqual(box.x + box.width);
          expect(label.rect.y + label.rect.height, `"${label.text}" bottom edge`)
            .toBeLessThanOrEqual(box.y + box.height);
        }
      });

      it("never lets an opaque label plate cover another edge's line", () => {
        // The plate is filled with the figure background and paints above the
        // edge layer, so a plate on someone else's line erases it. Re-sampled
        // at 400 points per path so the check cannot be fooled by the layout's
        // own sampling density.
        const labels = layout.edges
          .map((edge, index) => ({ index, label: edge.label }))
          .filter((entry): entry is { index: number; label: NonNullable<typeof entry.label> } =>
            entry.label !== null);
        for (const { index, label } of labels) {
          const rect: Rect = {
            x: label.cx - label.width / 2,
            y: label.cy - label.height / 2,
            width: label.width,
            height: label.height,
          };
          layout.edges.forEach((other, otherIndex) => {
            // A plate straddling its own straight line is the conventional
            // rendering; a plate over a self-loop's arc is not.
            if (otherIndex === index && !other.loop) return;
            const hits = pathPoints(other.path).filter((point) => inside(rect, point)).length;
            expect(
              hits,
              `"${label.text}" covers ${other.edge.from}->${other.edge.to} (${other.path})`,
            ).toBe(0);
          });
        }
      });

      it("keeps every label within reach of the edge it names", () => {
        // Without this the canvas-containment checks are tautologies: the
        // viewBox is derived from where the labels landed, so a label placed
        // anywhere at all stays "inside" it.
        for (const edge of layout.edges) {
          if (edge.label === null) continue;
          const points = pathPoints(edge.path);
          const nearest = Math.min(...points.map((point) =>
            Math.hypot(point.x - edge.label!.cx, point.y - edge.label!.cy)));
          expect(
            nearest,
            `"${edge.label.text}" is ${Math.round(nearest)} from its own edge`,
          ).toBeLessThanOrEqual(edge.label.width / 2 + 60);
        }
      });

      it("resolves every label without falling back to a crowded position", () => {
        const crowded = layout.edges
          .filter((edge) => edge.label?.crowded === true)
          .map((edge) => edge.label?.text);
        expect(crowded).toEqual([]);
      });

      it("gives every edge its own path and arrow", () => {
        const paths = layout.edges.map((edge) => edge.path);
        expect(new Set(paths).size).toBe(paths.length);
        const arrows = layout.edges.map((edge) => edge.arrow);
        expect(new Set(arrows).size).toBe(arrows.length);
      });

      it("is deterministic", () => {
        expect(layoutFlow(node)).toEqual(layout);
      });

      it("reports a canvas that contains every node and every edge path", () => {
        const box = layout.viewBox;
        for (const rect of nodeRects(layout)) {
          expect(rect.x).toBeGreaterThanOrEqual(box.x);
          expect(rect.y).toBeGreaterThanOrEqual(box.y);
          expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width);
          expect(rect.y + rect.height).toBeLessThanOrEqual(box.y + box.height);
        }
        for (const edge of layout.edges) {
          for (const value of edge.path.match(/-?\d+(?:\.\d+)?/g) ?? []) {
            expect(Number.isFinite(Number(value))).toBe(true);
          }
        }
      });
    });
  }

  it("layers a chain by dependency rather than by array order", () => {
    // Authored back-to-front: array order must not decide vertical order.
    const layout = layoutFlow(flow(
      [{ id: "C", label: "Third" }, { id: "A", label: "First" }, { id: "B", label: "Second" }],
      [{ from: "A", to: "B" }, { from: "B", to: "C" }],
    ));
    const y = new Map(layout.nodes.map((node) => [node.id, node.cy]));
    expect(y.get("A")).toBeLessThan(y.get("B") ?? 0);
    expect(y.get("B")).toBeLessThan(y.get("C") ?? 0);
  });

  it("keeps a narrow canvas for a chain so narrow viewports stay legible", () => {
    const layout = layoutFlow(flow(
      [
        { id: "A", label: "One" },
        { id: "B", label: "Two" },
        { id: "C", label: "Three" },
        { id: "D", label: "Four" },
      ],
      [{ from: "A", to: "B" }, { from: "B", to: "C" }, { from: "C", to: "D" }],
    ));
    // The previous fixed grid was always 720 wide, which scaled a 320px page to
    // 0.44 and rendered 15px labels at under 7 effective pixels.
    expect(layout.viewBox.width).toBeLessThan(320);
  });

  it("wraps an over-long node label instead of overflowing its box", () => {
    const layout = layoutFlow(flow(
      [{ id: "A", label: "把每一条口头约定都固化到一个衰减更慢且触发更可靠的载体上" }],
      [],
    ));
    const node = layout.nodes[0];
    expect(node?.lines.length).toBe(2);
    for (const line of node?.lines ?? []) {
      expect(textWidth(line, 15)).toBeLessThanOrEqual((node?.width ?? 0) - 36 + 1);
    }
  });

  it("rejects an edge that references an unknown node", () => {
    expect(() => layoutFlow(flow([{ id: "A", label: "Alpha" }], [{ from: "A", to: "Z" }])))
      .toThrow("FLOW_REFERENCE_INVALID");
  });

  for (const { name, node } of RESOLVED_CASES) {
    it(`reserves room for a resolved label: ${name}`, () => {
      const layout = layoutFlow(node, KIND_RESOLVER);
      const crowded = layout.edges
        .filter((edge) => edge.label?.crowded === true)
        .map((edge) => edge.label?.text);
      expect(crowded).toEqual([]);
      const nodes = nodeRects(layout);
      for (const label of labelRects(layout)) {
        for (const [index, rect] of nodes.entries()) {
          expect(
            overlaps(label.rect, rect),
            `"${label.text}" sits on node ${layout.nodes[index]?.id}`,
          ).toBe(false);
        }
      }
    });
  }

  it("keeps two labelled self loops on one node apart", () => {
    const layout = layoutFlow(flow(
      [{ id: "A", label: "Review" }, { id: "B", label: "Ship" }],
      [
        { from: "A", to: "B" },
        { from: "A", to: "A", label: "approve after review" },
        { from: "A", to: "A", label: "escalate to owner" },
      ],
    ));
    const labels = labelRects(layout);
    expect(labels).toHaveLength(2);
    const [first, second] = labels;
    expect(first && second && overlaps(first.rect, second.rect)).toBe(false);
    // Stacked vertically, not side by side on one line.
    expect(first?.rect.y).not.toBe(second?.rect.y);
  });

  it("balances a wrapped label instead of breaking at the first space", () => {
    const wide = layoutFlow(flow(
      [{ id: "A", label: "A 冷启动：地基与文档集合的建立、校验与固化流程" }],
      [],
    ));
    const node = wide.nodes[0];
    expect(node?.lines).toHaveLength(2);
    // The old first-space rule produced ["A", <everything else>] and a 366-wide box.
    expect(node?.lines[0]?.trim().length).toBeGreaterThan(1);
    expect(node?.width).toBeLessThan(280);

    // A leading space must never produce an empty first line.
    const leading = layoutFlow(flow(
      [{ id: "A", label: " Verylongunbrokenidentifier_that_keeps_going_and_going_here" }],
      [],
    ));
    for (const line of leading.nodes[0]?.lines ?? []) expect(line).not.toBe("");
  });

  it("keeps plates off other edges across a deterministic sweep of flows", () => {
    // One hand-picked fixture cannot cover this: whether a plate slips between
    // two collision samples depends on the edge's length and curvature. A
    // seeded sweep covers the class. Fixed seed, so failures are reproducible.
    let seed = 0x5eed;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const words = ["gate red, fix and resubmit", "timeout after 3 tries", "approved", "escalate", "retry once", "needs a second reviewer"];
    let checked = 0;
    for (let trial = 0; trial < 120; trial += 1) {
      const count = 3 + Math.floor(next() * 5);
      const nodes = Array.from({ length: count }, (_, i) => ({
        id: `n${i}`,
        label: `Stage ${i} ${words[i % words.length]?.slice(0, 4 + Math.floor(next() * 12)) ?? ""}`,
      }));
      const edges: { from: string; to: string; label?: string }[] = [];
      for (let i = 1; i < count; i += 1) edges.push({ from: `n${i - 1}`, to: `n${i}` });
      const extra = 1 + Math.floor(next() * 3);
      for (let e = 0; e < extra; e += 1) {
        const a = Math.floor(next() * count);
        const b = Math.floor(next() * count);
        if (a === b) continue;
        edges.push({ from: `n${a}`, to: `n${b}`, label: words[Math.floor(next() * words.length)] ?? "note" });
      }
      const layout = layoutFlow(flow(nodes, edges));
      layout.edges.forEach((edge, index) => {
        if (edge.label === null) return;
        const rect: Rect = {
          x: edge.label.cx - edge.label.width / 2,
          y: edge.label.cy - edge.label.height / 2,
          width: edge.label.width,
          height: edge.label.height,
        };
        layout.edges.forEach((other, otherIndex) => {
          if (otherIndex === index && !other.loop) return;
          checked += 1;
          const hits = pathPoints(other.path).filter((point) => inside(rect, point)).length;
          expect(
            hits,
            `trial ${trial}: "${edge.label?.text}" covers ${other.edge.from}->${other.edge.to}`,
          ).toBe(0);
        });
      });
    }
    expect(checked).toBeGreaterThan(500);
  });

  it("measures wide and narrow code points differently", () => {
    expect(textWidth("四个字符", 15)).toBeGreaterThan(textWidth("abcd", 15));
    expect(textWidth("", 15)).toBe(0);
  });
});
