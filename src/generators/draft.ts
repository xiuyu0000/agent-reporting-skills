import type { ReviewDocumentV1 } from "../protocol/index.js";

export const DRAFT_SLOT_MARKER = "Draft decision slot" as const;

export interface DraftReviewDocumentInput {
  readonly deliveryId: string;
  readonly documentId: string;
  readonly baseName: string;
  readonly repositoryStatus: ReviewDocumentV1["delivery"]["repositoryStatus"];
  readonly title: string;
  readonly language: string;
  readonly uiLocale: ReviewDocumentV1["document"]["uiLocale"];
  readonly asOf: string;
}

export function createDraftReviewDocument(input: DraftReviewDocumentInput): ReviewDocumentV1 {
  return {
    format: "review-document/1",
    delivery: {
      id: input.deliveryId,
      baseName: input.baseName,
      repositoryStatus: input.repositoryStatus,
      outputs: {
        agent: `${input.baseName}_AGENT.md`,
        approval: `${input.baseName}_APPROVAL.html`,
      },
    },
    document: {
      id: input.documentId,
      title: input.title,
      language: input.language,
      uiLocale: input.uiLocale,
      contentVersion: 1,
      asOf: input.asOf,
      round: 1,
      status: "draft",
      summary: "Draft review document awaiting verified content.",
    },
    continuation: {
      objective: "Replace the four draft decision slots with review-ready decisions and validate the document.",
      scope: ["Populate B001 through B004 with independently reviewable decisions."],
      exclusions: ["Do not infer facts, decisions, or approvals during initialization."],
      currentState: [{
        type: "paragraph",
        content: [{
          type: "text",
          text: "Initialization created a draft contract only; no evidence or approval exists.",
        }],
      }],
      nextActions: [{
        id: "ACT-001",
        action: "Replace every draft decision slot and provide verified evidence.",
        verification: "The completed document validates after its status is explicitly set to in-review.",
      }],
      validationEvidence: [],
      evidenceGaps: [],
    },
    evidence: {
      sourceHierarchy: [],
      facts: [],
      decisions: [],
      constraints: [],
      risks: [],
      openQuestions: [],
      conflicts: [],
    },
    blocks: [1, 2, 3, 4].map((number) => {
      const id = `B${String(number).padStart(3, "0")}`;
      return {
        id,
        tier: "T0" as const,
        title: `${DRAFT_SLOT_MARKER} ${id}`,
        summary: `${DRAFT_SLOT_MARKER} ${id} is awaiting replacement.`,
        body: [{
          type: "paragraph" as const,
          content: [{
            type: "text" as const,
            text: `${DRAFT_SLOT_MARKER} ${id}. Replace it with review-ready content.`,
          }],
        }],
        dependencies: [],
        claimRefs: [],
        decisionRefs: [],
      };
    }),
    glossary: [],
    approvals: { history: [], currentFrozen: [] },
    lineage: {
      previousReviewDigest: null,
      idHighWater: {
        block: 4,
        source: 0,
        fact: 0,
        decision: 0,
        glossary: 0,
        note: 0,
        topic: 0,
      },
      consumedPackets: [],
      topicMappings: [],
      impactAssessments: [],
      feedbackResolutions: [],
    },
  };
}

function contentHasMarker(value: unknown): boolean {
  if (typeof value === "string") return value.includes(DRAFT_SLOT_MARKER);
  if (Array.isArray(value)) return value.some(contentHasMarker);
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(contentHasMarker);
}

export function containsDraftDecisionSlot(document: ReviewDocumentV1): boolean {
  return document.blocks.some((block) => contentHasMarker(block));
}
