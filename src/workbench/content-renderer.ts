import type { ContentNode, InlineNode } from "../protocol/index.js";
import type { WorkbenchStrings } from "./i18n.js";
import { renderFlow } from "./flow-renderer.js";
import { renderLink } from "./link-renderer.js";

export interface ContentRenderContext {
  readonly glossary: ReadonlyMap<string, { term: string; definition: string }>;
  readonly strings: WorkbenchStrings;
  readonly uiLocale: string;
  readonly contentLanguage: string;
}

function appendInline(
  parent: Node,
  node: InlineNode,
  context: ContentRenderContext,
): void {
  const ownerDocument = parent.ownerDocument;
  if (!ownerDocument) throw new Error("OWNER_DOCUMENT_MISSING");
  switch (node.type) {
    case "text":
      parent.appendChild(ownerDocument.createTextNode(node.text));
      break;
    case "strong": {
      const element = ownerDocument.createElement("strong");
      element.textContent = node.text;
      parent.appendChild(element);
      break;
    }
    case "emphasis": {
      const element = ownerDocument.createElement("em");
      element.textContent = node.text;
      parent.appendChild(element);
      break;
    }
    case "inlineCode": {
      const element = ownerDocument.createElement("code");
      element.textContent = node.text;
      parent.appendChild(element);
      break;
    }
    case "link":
      parent.appendChild(renderLink(ownerDocument, node, context.strings, context.uiLocale));
      break;
    case "termRef": {
      const entry = context.glossary.get(node.glossaryId);
      if (!entry) throw new Error("GLOSSARY_REFERENCE_INVALID");
      // One affordance, two channels: hovering or focusing the term previews
      // the definition, activating it jumps to the in-file glossary appendix.
      // The hover stays a supplement — the appendix the link targets is the
      // in-file carrier spec §7.2 requires.
      const anchor = ownerDocument.createElement("a");
      anchor.className = "term-ref";
      anchor.href = `#glossary-${node.glossaryId}`;
      anchor.setAttribute("data-internal-ref", "true");
      anchor.setAttribute("data-tip", entry.definition);
      anchor.setAttribute("data-tip-lang", context.contentLanguage);
      const label = ownerDocument.createElement("span");
      label.lang = context.contentLanguage;
      label.textContent = node.text ?? entry.term;
      const jumpHint = ownerDocument.createElement("span");
      jumpHint.className = "visually-hidden";
      jumpHint.lang = context.uiLocale;
      jumpHint.textContent = ` (${context.strings.glossaryJump})`;
      anchor.append(label, jumpHint);
      parent.appendChild(anchor);
      break;
    }
  }
}

function appendInlineSequence(
  parent: Node,
  nodes: readonly InlineNode[],
  context: ContentRenderContext,
): void {
  for (const node of nodes) appendInline(parent, node, context);
}

function renderSimpleContent(
  ownerDocument: Document,
  node: Extract<ContentNode, { type: "paragraph" | "list" | "code" }>,
  context: ContentRenderContext,
): HTMLElement {
  return renderContentNode(ownerDocument, node, context);
}

export function renderContentNode(
  ownerDocument: Document,
  node: ContentNode,
  context: ContentRenderContext,
): HTMLElement {
  switch (node.type) {
    case "paragraph": {
      const paragraph = ownerDocument.createElement("p");
      appendInlineSequence(paragraph, node.content, context);
      return paragraph;
    }
    case "list": {
      const list = ownerDocument.createElement(node.ordered ? "ol" : "ul");
      for (const item of node.items) {
        const listItem = ownerDocument.createElement("li");
        appendInlineSequence(listItem, item, context);
        list.append(listItem);
      }
      return list;
    }
    case "table": {
      const region = ownerDocument.createElement("div");
      region.className = "scroll-region table-region";
      region.tabIndex = 0;
      region.setAttribute("role", "region");
      region.setAttribute("aria-label", context.strings.tableRegion);
      region.lang = context.uiLocale;
      const table = ownerDocument.createElement("table");
      table.lang = context.contentLanguage;
      const head = ownerDocument.createElement("thead");
      const headerRow = ownerDocument.createElement("tr");
      for (const header of node.headers) {
        const cell = ownerDocument.createElement("th");
        cell.scope = "col";
        appendInlineSequence(cell, header, context);
        headerRow.append(cell);
      }
      head.append(headerRow);
      const body = ownerDocument.createElement("tbody");
      for (const row of node.rows) {
        const tableRow = ownerDocument.createElement("tr");
        for (const value of row) {
          const cell = ownerDocument.createElement("td");
          appendInlineSequence(cell, value, context);
          tableRow.append(cell);
        }
        body.append(tableRow);
      }
      table.append(head, body);
      region.append(table);
      return region;
    }
    case "code": {
      const region = ownerDocument.createElement("div");
      region.className = "scroll-region code-region";
      region.tabIndex = 0;
      region.setAttribute("role", "region");
      region.setAttribute("aria-label", context.strings.codeRegion);
      region.lang = context.uiLocale;
      const pre = ownerDocument.createElement("pre");
      pre.lang = context.contentLanguage;
      const code = ownerDocument.createElement("code");
      if (node.language !== undefined) code.dataset.language = node.language;
      code.textContent = node.text;
      pre.append(code);
      region.append(pre);
      return region;
    }
    case "callout": {
      const aside = ownerDocument.createElement("aside");
      aside.className = `callout callout-${node.tone}`;
      const tone = ownerDocument.createElement("span");
      tone.className = "callout-tone";
      tone.lang = context.uiLocale;
      tone.textContent = node.tone === "info"
        ? `ⓘ ${context.strings.calloutInfo}`
        : node.tone === "warning"
          ? `⚠ ${context.strings.calloutWarning}`
          : `◆ ${context.strings.calloutDecision}`;
      aside.append(tone);
      if (node.title !== undefined) {
        const title = ownerDocument.createElement("strong");
        title.textContent = node.title;
        aside.append(title);
      }
      for (const child of node.content) {
        aside.append(renderSimpleContent(ownerDocument, child, context));
      }
      return aside;
    }
    case "steps": {
      const list = ownerDocument.createElement("ol");
      list.className = "steps";
      for (const step of node.items) {
        const item = ownerDocument.createElement("li");
        const title = ownerDocument.createElement("strong");
        title.textContent = step.title;
        item.append(title);
        for (const child of step.content) {
          item.append(renderSimpleContent(ownerDocument, child, context));
        }
        list.append(item);
      }
      return list;
    }
    case "scale": {
      // A ranked ladder, a spectrum and a proportion are the same shape: an
      // ordered set of labelled positions on one named axis. Rendering it as
      // real text plus a proportional bar means the visible DOM is already the
      // text equivalent — no colour or length carries meaning on its own.
      const figure = ownerDocument.createElement("figure");
      figure.className = "scale";
      const caption = ownerDocument.createElement("figcaption");
      const title = ownerDocument.createElement("strong");
      title.textContent = node.title;
      const summary = ownerDocument.createElement("span");
      summary.textContent = node.description;
      const axis = ownerDocument.createElement("span");
      axis.className = "scale-axis";
      axis.textContent = `${node.axis.lowLabel} → ${node.axis.highLabel}`;
      caption.append(title, summary, axis);
      const list = ownerDocument.createElement("ol");
      list.className = "scale-items";
      for (const item of node.items) {
        const row = ownerDocument.createElement("li");
        const label = ownerDocument.createElement("span");
        label.className = "scale-label";
        label.textContent = item.label;
        const track = ownerDocument.createElement("span");
        track.className = "scale-track";
        const fill = ownerDocument.createElement("span");
        fill.className = "scale-fill";
        fill.style.width = `${item.position}%`;
        track.append(fill);
        const value = ownerDocument.createElement("span");
        value.className = "scale-value";
        value.textContent = item.display ?? `${item.position}/100`;
        row.append(label, track, value);
        if (item.note !== undefined) {
          const note = ownerDocument.createElement("span");
          note.className = "scale-note";
          appendInlineSequence(note, item.note, context);
          row.append(note);
        }
        list.append(row);
      }
      figure.append(caption, list);
      return figure;
    }
    case "flow":
      return renderFlow(ownerDocument, node, context.strings, context.uiLocale);
  }
}

export function renderContentNodes(
  ownerDocument: Document,
  nodes: readonly ContentNode[],
  context: ContentRenderContext,
): DocumentFragment {
  const fragment = ownerDocument.createDocumentFragment();
  for (const node of nodes) fragment.append(renderContentNode(ownerDocument, node, context));
  return fragment;
}
