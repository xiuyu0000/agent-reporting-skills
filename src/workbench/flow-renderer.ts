import type { ContentNode } from "../protocol/index.js";
import type { WorkbenchStrings } from "./i18n.js";

type FlowNode = Extract<ContentNode, { type: "flow" }>;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function renderFlow(
  ownerDocument: Document,
  flow: FlowNode,
  strings: WorkbenchStrings,
  uiLocale: string,
): HTMLElement {
  const figure = ownerDocument.createElement("figure");
  figure.className = "flow";

  const caption = ownerDocument.createElement("figcaption");
  const title = ownerDocument.createElement("strong");
  title.textContent = flow.title;
  const description = ownerDocument.createElement("span");
  description.textContent = flow.description;
  caption.append(title, description);

  const svg = ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
  const rowCount = Math.ceil(flow.nodes.length / 2);
  svg.setAttribute("viewBox", `0 0 720 ${Math.max(150, rowCount * 120 + 30)}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${flow.title}. ${flow.description}`);
  svg.setAttribute("focusable", "false");

  const positions = new Map<string, { x: number; y: number }>();
  flow.nodes.forEach((node, index) => {
    positions.set(node.id, {
      x: 180 + (index % 2) * 360,
      y: 64 + Math.floor(index / 2) * 120,
    });
  });

  const edgeLayer = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
  for (const edge of flow.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) throw new Error("FLOW_REFERENCE_INVALID");
    const deltaX = to.x - from.x;
    const deltaY = to.y - from.y;
    const distance = Math.hypot(deltaX, deltaY);
    if (distance === 0) {
      const loopDirection = from.x > 360 ? -1 : 1;
      const edgeX = from.x + loopDirection * 140;
      const controlX = from.x + loopDirection * 210;
      const path = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
      path.setAttribute(
        "d",
        `M ${edgeX} ${from.y - 12} C ${controlX} ${from.y - 50}, ${controlX} ${from.y + 70}, ${edgeX} ${from.y + 12}`,
      );
      path.setAttribute("class", "flow-edge flow-loop");
      path.setAttribute("fill", "none");
      const arrow = ownerDocument.createElementNS(SVG_NAMESPACE, "polygon");
      arrow.setAttribute(
        "points",
        `${edgeX},${from.y + 12} ${from.x + loopDirection * 156},${from.y + 9} ${from.x + loopDirection * 151},${from.y + 25}`,
      );
      arrow.setAttribute("class", "flow-arrow");
      edgeLayer.append(path, arrow);
      if (edge.label !== undefined) {
        const label = ownerDocument.createElementNS(SVG_NAMESPACE, "text");
        label.setAttribute("x", String(from.x + loopDirection * 202));
        label.setAttribute("y", String(from.y - 3));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("class", "flow-label");
        label.textContent = edge.label;
        edgeLayer.append(label);
      }
      continue;
    }
    const unitX = deltaX / distance;
    const unitY = deltaY / distance;
    const horizontalBoundary = unitX === 0 ? Number.POSITIVE_INFINITY : 140 / Math.abs(unitX);
    const verticalBoundary = unitY === 0 ? Number.POSITIVE_INFINITY : 29 / Math.abs(unitY);
    const boundary = Math.min(horizontalBoundary, verticalBoundary);
    const startX = from.x + unitX * boundary;
    const startY = from.y + unitY * boundary;
    const endX = to.x - unitX * boundary;
    const endY = to.y - unitY * boundary;
    const line = ownerDocument.createElementNS(SVG_NAMESPACE, "line");
    line.setAttribute("x1", String(startX));
    line.setAttribute("y1", String(startY));
    line.setAttribute("x2", String(endX));
    line.setAttribute("y2", String(endY));
    line.setAttribute("class", "flow-edge");
    const arrow = ownerDocument.createElementNS(SVG_NAMESPACE, "polygon");
    const baseX = endX - unitX * 14;
    const baseY = endY - unitY * 14;
    const perpendicularX = -unitY * 7;
    const perpendicularY = unitX * 7;
    arrow.setAttribute(
      "points",
      `${endX},${endY} ${baseX + perpendicularX},${baseY + perpendicularY} ${baseX - perpendicularX},${baseY - perpendicularY}`,
    );
    arrow.setAttribute("class", "flow-arrow");
    edgeLayer.append(line, arrow);
    if (edge.label !== undefined) {
      const label = ownerDocument.createElementNS(SVG_NAMESPACE, "text");
      label.setAttribute("x", String((startX + endX) / 2));
      label.setAttribute("y", String((startY + endY) / 2 - 9));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "flow-label");
      label.textContent = edge.label;
      edgeLayer.append(label);
    }
  }

  svg.append(edgeLayer);
  flow.nodes.forEach((node) => {
    const position = positions.get(node.id);
    if (!position) throw new Error("FLOW_REFERENCE_INVALID");
    const group = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    group.setAttribute("transform", `translate(${position.x - 140} ${position.y - 29})`);
    const rect = ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
    rect.setAttribute("width", "280");
    rect.setAttribute("height", "58");
    rect.setAttribute("rx", "12");
    rect.setAttribute("class", "flow-node");
    const text = ownerDocument.createElementNS(SVG_NAMESPACE, "text");
    text.setAttribute("x", "140");
    text.setAttribute("y", "35");
    text.setAttribute("text-anchor", "middle");
    text.textContent = node.label;
    group.append(rect, text);
    svg.append(group);
  });

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
    item.textContent = `${node.id}: ${node.label}`;
    nodesList.append(item);
  }
  const edgesHeading = ownerDocument.createElement("h4");
  edgesHeading.textContent = strings.flowConnections;
  edgesHeading.lang = uiLocale;
  const edgesList = ownerDocument.createElement("ul");
  for (const edge of flow.edges) {
    const item = ownerDocument.createElement("li");
    item.textContent = edge.label === undefined
      ? `${edge.from} → ${edge.to}`
      : `${edge.from} → ${edge.to}: ${edge.label}`;
    edgesList.append(item);
  }
  details.append(summary, descriptionText, nodesHeading, nodesList, edgesHeading, edgesList);
  figure.append(caption, svg, details);
  return figure;
}
