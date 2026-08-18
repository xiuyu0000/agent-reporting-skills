import type { ReviewDocumentV1 } from "../../protocol/index.js";

type ContentNode = ReviewDocumentV1["blocks"][number]["body"][number];
type InlineNode = Extract<ContentNode, { type: "paragraph" }>["content"][number];

export interface ReviewDocumentContentVisitor {
  /**
   * Every inline node reachable from the four review-document content roots,
   * with the JSON Pointer of the node itself.
   */
  readonly inline?: (node: InlineNode, path: string) => void;
  /**
   * Every authored free-text string in the document, with its JSON Pointer.
   * Identifiers, digests, enums, hrefs and numbers are deliberately excluded:
   * only text a human wrote is scanned.
   */
  readonly text?: (value: string, path: string) => void;
}

/**
 * The single review-document content walker. Deterministic validation needs one
 * traversal that both the internal-link check and the unreplaced-placeholder
 * check share, so the two can never disagree about which fields are content.
 */
export function visitReviewDocumentContent(
  document: ReviewDocumentV1,
  visitor: ReviewDocumentContentVisitor,
): void {
  const { inline, text } = visitor;

  const visitText = (value: string | undefined, path: string): void => {
    if (text !== undefined && typeof value === "string") text(value, path);
  };

  const visitInline = (nodes: readonly InlineNode[], path: string): void => {
    for (const [index, node] of nodes.entries()) {
      const nodePath = `${path}/${index}`;
      inline?.(node, nodePath);
      visitText(node.text, `${nodePath}/text`);
    }
  };

  const visitContent = (nodes: readonly ContentNode[], path: string): void => {
    for (const [index, node] of nodes.entries()) {
      const nodePath = `${path}/${index}`;
      if (node.type === "paragraph") visitInline(node.content, `${nodePath}/content`);
      else if (node.type === "list") {
        node.items.forEach((item, itemIndex) => visitInline(item, `${nodePath}/items/${itemIndex}`));
      } else if (node.type === "table") {
        node.headers.forEach((header, headerIndex) => visitInline(header, `${nodePath}/headers/${headerIndex}`));
        node.rows.forEach((row, rowIndex) => row.forEach((cell, cellIndex) =>
          visitInline(cell, `${nodePath}/rows/${rowIndex}/${cellIndex}`)));
      } else if (node.type === "code") {
        visitText(node.text, `${nodePath}/text`);
        visitText(node.language, `${nodePath}/language`);
      } else if (node.type === "callout") {
        visitText(node.title, `${nodePath}/title`);
        visitContent(node.content, `${nodePath}/content`);
      } else if (node.type === "steps") {
        node.items.forEach((step, stepIndex) => {
          visitText(step.title, `${nodePath}/items/${stepIndex}/title`);
          visitContent(step.content, `${nodePath}/items/${stepIndex}/content`);
        });
      } else {
        visitText(node.title, `${nodePath}/title`);
        visitText(node.description, `${nodePath}/description`);
        node.nodes.forEach((item, itemIndex) => visitText(item.label, `${nodePath}/nodes/${itemIndex}/label`));
        node.edges.forEach((edge, edgeIndex) => visitText(edge.label, `${nodePath}/edges/${edgeIndex}/label`));
      }
    }
  };

  visitText(document.delivery.splitGroup?.reason, "/delivery/splitGroup/reason");
  visitText(document.document.title, "/document/title");
  visitText(document.document.summary, "/document/summary");

  visitText(document.continuation.objective, "/continuation/objective");
  document.continuation.scope.forEach((item, index) => visitText(item, `/continuation/scope/${index}`));
  document.continuation.exclusions.forEach((item, index) => visitText(item, `/continuation/exclusions/${index}`));
  visitContent(document.continuation.currentState, "/continuation/currentState");
  document.continuation.nextActions.forEach((action, index) => {
    visitText(action.action, `/continuation/nextActions/${index}/action`);
    visitText(action.owner, `/continuation/nextActions/${index}/owner`);
    visitText(action.verification, `/continuation/nextActions/${index}/verification`);
  });
  document.continuation.validationEvidence.forEach((item, index) =>
    visitText(item, `/continuation/validationEvidence/${index}`));
  document.continuation.evidenceGaps.forEach((item, index) =>
    visitText(item, `/continuation/evidenceGaps/${index}`));

  document.evidence.sourceHierarchy.forEach((source, index) => {
    visitText(source.label, `/evidence/sourceHierarchy/${index}/label`);
    visitText(source.reference, `/evidence/sourceHierarchy/${index}/reference`);
  });
  document.evidence.facts.forEach((item, index) => visitContent(item.content, `/evidence/facts/${index}/content`));
  document.evidence.decisions.forEach((item, index) =>
    visitContent(item.content, `/evidence/decisions/${index}/content`));
  document.evidence.constraints.forEach((item, index) => visitText(item, `/evidence/constraints/${index}`));
  document.evidence.risks.forEach((item, index) => visitText(item, `/evidence/risks/${index}`));
  document.evidence.openQuestions.forEach((item, index) => visitText(item, `/evidence/openQuestions/${index}`));
  document.evidence.conflicts.forEach((conflict, index) => {
    visitText(conflict.description, `/evidence/conflicts/${index}/description`);
    visitText(conflict.resolution, `/evidence/conflicts/${index}/resolution`);
  });

  document.blocks.forEach((block, index) => {
    visitText(block.title, `/blocks/${index}/title`);
    visitText(block.summary, `/blocks/${index}/summary`);
    visitText(block.whyTier, `/blocks/${index}/whyTier`);
    visitText(block.ask, `/blocks/${index}/ask`);
    visitText(block.changed?.summary, `/blocks/${index}/changed/summary`);
    visitContent(block.body, `/blocks/${index}/body`);
  });

  document.glossary.forEach((entry, index) => {
    visitText(entry.term, `/glossary/${index}/term`);
    visitText(entry.definition, `/glossary/${index}/definition`);
  });

  document.lineage.impactAssessments.forEach((item, index) =>
    visitText(item.reason, `/lineage/impactAssessments/${index}/reason`));
  document.lineage.feedbackResolutions.forEach((item, index) =>
    visitText(item.reason, `/lineage/feedbackResolutions/${index}/reason`));
}
