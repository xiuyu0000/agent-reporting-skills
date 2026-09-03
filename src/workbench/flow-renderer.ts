import type { ContentNode } from "../protocol/index.js";
import type { WorkbenchStrings } from "./i18n.js";
import { DECISION_BEVEL, layoutFlow, type PlacedNode } from "./flow-layout.js";

type FlowNode = Extract<ContentNode, { type: "flow" }>;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const NODE_LINE_H = 19;

function nodeKindWord(kind: PlacedNode["kind"], strings: WorkbenchStrings): string | null {
  switch (kind) {
    case "start": return strings.flowKindStart;
    case "decision": return strings.flowKindDecision;
    case "end": return strings.flowKindEnd;
    // A plain step adds no word: the shape is the default and naming it is noise.
    case "step": return null;
  }
}

function edgeKindWord(
  kind: "then" | "yes" | "no" | "else" | undefined,
  strings: WorkbenchStrings,
): string | null {
  switch (kind) {
    case "yes": return strings.flowEdgeYes;
    case "no": return strings.flowEdgeNo;
    case "else": return strings.flowEdgeElse;
    case "then": return strings.flowEdgeThen;
    case undefined: return null;
  }
}

/**
 * Node outlines carry meaning, so the kind word is repeated in the text
 * alternative: shape is never the only channel (spec §13.5).
 */
function nodeOutline(node: PlacedNode): { name: string; attribute: string; value: string } {
  const left = node.cx - node.width / 2;
  const top = node.cy - node.height / 2;
  const right = left + node.width;
  const bottom = top + node.height;
  if (node.kind === "decision") {
    const bevel = Math.min(DECISION_BEVEL, node.width / 3);
    const middle = node.cy;
    return {
      name: "polygon",
      attribute: "points",
      value: `${left},${middle} ${left + bevel},${top} ${right - bevel},${top} `
        + `${right},${middle} ${right - bevel},${bottom} ${left + bevel},${bottom}`,
    };
  }
  return { name: "rect", attribute: "rx", value: node.kind === "step" ? "10" : String(node.height / 2) };
}

/**
 * Reader-facing names for the text alternative. design.md §11.3 and §7.3 require
 * the alternative to be built from the title, description, node labels and edge
 * relationships — not from the local node ids, which mean nothing to a
 * zero-context reviewer. Ids reappear only to disambiguate repeated labels.
 */
function readableNames(flow: FlowNode): Map<string, string> {
  const seen = new Map<string, number>();
  for (const node of flow.nodes) seen.set(node.label, (seen.get(node.label) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const node of flow.nodes) {
    names.set(node.id, (seen.get(node.label) ?? 0) > 1 ? `${node.label} (${node.id})` : node.label);
  }
  return names;
}

export function renderFlow(
  ownerDocument: Document,
  flow: FlowNode,
  strings: WorkbenchStrings,
  uiLocale: string,
): HTMLElement {
  const layout = layoutFlow(flow, (edge) => {
    const word = edgeKindWord(edge.kind, strings);
    if (edge.label === undefined) return word ?? undefined;
    return word === null ? edge.label : `${word} · ${edge.label}`;
  });

  const figure = ownerDocument.createElement("figure");
  figure.className = "flow";

  const caption = ownerDocument.createElement("figcaption");
  const title = ownerDocument.createElement("strong");
  title.textContent = flow.title;
  const description = ownerDocument.createElement("span");
  description.textContent = flow.description;
  caption.append(title, description);

  const svg = ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
  const box = layout.viewBox;
  svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${flow.title}. ${flow.description}`);
  svg.setAttribute("focusable", "false");

  // Three explicit paint layers. Labels sit above the node boxes so an opaque
  // rect can never swallow one, while collision-aware placement keeps them off
  // the boxes in the first place.
  const edgeLayer = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
  const nodeLayer = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
  const labelLayer = ownerDocument.createElementNS(SVG_NAMESPACE, "g");

  for (const placed of layout.edges) {
    const path = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", placed.path);
    path.setAttribute("class", placed.loop ? "flow-edge flow-loop" : "flow-edge");
    path.setAttribute("fill", "none");
    const arrow = ownerDocument.createElementNS(SVG_NAMESPACE, "polygon");
    arrow.setAttribute("points", placed.arrow);
    arrow.setAttribute("class", "flow-arrow");
    edgeLayer.append(path, arrow);

    if (!placed.label) continue;
    const label = placed.label;
    const group = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    group.setAttribute("class", label.crowded ? "flow-label-box crowded" : "flow-label-box");
    const plate = ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
    plate.setAttribute("x", String(label.cx - label.width / 2));
    plate.setAttribute("y", String(label.cy - label.height / 2));
    plate.setAttribute("width", String(label.width));
    plate.setAttribute("height", String(label.height));
    plate.setAttribute("rx", "4");
    plate.setAttribute("class", "flow-label-plate");
    const text = ownerDocument.createElementNS(SVG_NAMESPACE, "text");
    text.setAttribute("x", String(label.cx));
    text.setAttribute("y", String(label.cy + 4.5));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "flow-label");
    text.textContent = label.text;
    group.append(plate, text);
    if (label.text !== label.full) {
      // The plate shows an elided label; the authored string stays reachable
      // here and, in full, in the text alternative below the diagram.
      const full = ownerDocument.createElementNS(SVG_NAMESPACE, "title");
      full.textContent = label.full;
      group.append(full);
    }
    labelLayer.append(group);
  }

  for (const node of layout.nodes) {
    const group = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    const outline = nodeOutline(node);
    const shape = ownerDocument.createElementNS(SVG_NAMESPACE, outline.name);
    if (outline.name === "rect") {
      shape.setAttribute("x", String(node.cx - node.width / 2));
      shape.setAttribute("y", String(node.cy - node.height / 2));
      shape.setAttribute("width", String(node.width));
      shape.setAttribute("height", String(node.height));
    }
    shape.setAttribute(outline.attribute, outline.value);
    shape.setAttribute("class", `flow-node flow-node-${node.kind}`);
    group.append(shape);
    const first = node.cy - ((node.lines.length - 1) * NODE_LINE_H) / 2 + 5;
    node.lines.forEach((line, index) => {
      const text = ownerDocument.createElementNS(SVG_NAMESPACE, "text");
      text.setAttribute("x", String(node.cx));
      text.setAttribute("y", String(first + index * NODE_LINE_H));
      text.setAttribute("text-anchor", "middle");
      text.textContent = line;
      group.append(text);
    });
    nodeLayer.append(group);
  }

  svg.append(edgeLayer, nodeLayer, labelLayer);

  const names = readableNames(flow);
  const details = ownerDocument.createElement("details");
  details.className = "flow-alternative";
  const summary = ownerDocument.createElement("summary");
  summary.textContent = strings.flowTextAlternative;
  summary.lang = uiLocale;
  const descriptionText = ownerDocument.createElement("p");
  descriptionText.textContent = flow.description;
  const nodesHeading = ownerDocument.createElement("h4");
  nodesHeading.textContent = flow.title;
  const nodesList = ownerDocument.createElement("ul");
  for (const node of flow.nodes) {
    const item = ownerDocument.createElement("li");
    const word = nodeKindWord(node.kind ?? "step", strings);
    const name = names.get(node.id) ?? node.label;
    item.textContent = word === null ? name : `${name} (${word})`;
    nodesList.append(item);
  }
  const edgesHeading = ownerDocument.createElement("h4");
  edgesHeading.textContent = strings.flowConnections;
  edgesHeading.lang = uiLocale;
  const edgesList = ownerDocument.createElement("ul");
  for (const edge of flow.edges) {
    const item = ownerDocument.createElement("li");
    const from = names.get(edge.from) ?? edge.from;
    const to = names.get(edge.to) ?? edge.to;
    const parts = [edgeKindWord(edge.kind, strings), edge.label]
      .filter((part): part is string => part !== null && part !== undefined);
    item.textContent = parts.length === 0
      ? `${from} → ${to}`
      : `${from} → ${to}: ${parts.join(" — ")}`;
    edgesList.append(item);
  }
  details.append(summary, descriptionText, nodesHeading, nodesList, edgesHeading, edgesList);
  figure.append(caption, svg, details);
  return figure;
}
