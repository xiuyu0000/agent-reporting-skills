/* eslint-disable */
/**
 * Generated from the public review JSON Schemas.
 * Do not edit by hand; run `npm run schema:types`.
 */

export namespace ReviewDocumentSchema {
  export type DeliveryId = string;
  export type SafeRelativePath = string;
  export type SplitGroupId = string;
  export type NonEmptyString = string;
  export type DocumentId = string;
  export type ZonedDateTime = string;
  export type ContentNode =
    ParagraphNode | ListNode | TableNode | CodeNode | CalloutNode | StepsNode | FlowNode | ScaleNode;
  export type InlineNode =
    TextNode | StrongNode | EmphasisNode | InlineCodeNode | LinkNode | TermRefNode;
  export type GlossaryId = string;
  export type SimpleContentNode = ParagraphNode | ListNode | CodeNode;
  export type ActionId = string;
  export type SourceId = string;
  export type Freshness = StaticFreshness | TimeSensitiveFreshness;
  export type FactId = string;
  export type Confidence = "high" | "medium" | "low" | "unknown";
  export type DecisionId = string;
  export type EvidenceItemId = string;
  export type DecisionBlock = TierTwoDecisionBlock | StandardDecisionBlock;
  export type BlockId = string;
  export type Sha256Digest = string;
  export type PacketId = string;
  export type TopicId = string;
  export type FeedbackResolution = ContextFeedbackResolution | BlockFeedbackResolution;
  export type FeedbackId = string;

  /**
   * Canonical review input and cross-round state for review-document/1.
   */
  export interface ReviewDocumentV1 {
    format: "review-document/1";
    delivery: Delivery;
    document: DocumentIdentity;
    continuation: AgentContinuation;
    evidence: EvidenceSnapshot;
    /**
     * @minItems 4
     * @maxItems 15
     */
    blocks: DecisionBlock[];
    glossary: GlossaryEntry[];
    approvals: ApprovalSnapshot;
    lineage: Lineage;
  }
  export interface Delivery {
    id: DeliveryId;
    baseName: string;
    repositoryStatus: "local-only" | "tracked-approved" | "public-approved";
    outputs: DeliveryOutputs;
    splitGroup?: SplitGroup;
  }
  export interface DeliveryOutputs {
    agent: SafeRelativePath;
    approval: SafeRelativePath;
  }
  export interface SplitGroup {
    groupId: SplitGroupId;
    part: number;
    total: number;
    reason: NonEmptyString;
  }
  export interface DocumentIdentity {
    id: DocumentId;
    title: NonEmptyString;
    language: string;
    uiLocale: "zh-CN" | "en";
    contentVersion: number;
    asOf: ZonedDateTime;
    round: number;
    status: "draft" | "in-review" | "finalized";
    summary: NonEmptyString;
  }
  export interface AgentContinuation {
    objective: NonEmptyString;
    scope: NonEmptyString[];
    exclusions: NonEmptyString[];
    currentState: ContentNode[];
    nextActions: NextAction[];
    validationEvidence: NonEmptyString[];
    evidenceGaps: NonEmptyString[];
  }
  export interface ParagraphNode {
    type: "paragraph";
    /**
     * @minItems 1
     */
    content: InlineNode[];
  }
  export interface TextNode {
    type: "text";
    text: NonEmptyString;
  }
  export interface StrongNode {
    type: "strong";
    text: NonEmptyString;
  }
  export interface EmphasisNode {
    type: "emphasis";
    text: NonEmptyString;
  }
  export interface InlineCodeNode {
    type: "inlineCode";
    text: NonEmptyString;
  }
  export interface LinkNode {
    type: "link";
    text: NonEmptyString;
    href: string;
  }
  export interface TermRefNode {
    type: "termRef";
    glossaryId: GlossaryId;
    text?: NonEmptyString;
  }
  export interface ListNode {
    type: "list";
    ordered: boolean;
    /**
     * @minItems 1
     */
    items: InlineNode[][];
  }
  export interface TableNode {
    type: "table";
    /**
     * @minItems 1
     */
    headers: InlineNode[][];
    /**
     * @minItems 1
     */
    rows: InlineNode[][][];
  }
  export interface CodeNode {
    type: "code";
    language?: NonEmptyString;
    text: NonEmptyString;
  }
  export interface CalloutNode {
    type: "callout";
    tone: "info" | "warning" | "decision";
    title?: NonEmptyString;
    /**
     * @minItems 1
     */
    content: SimpleContentNode[];
  }
  export interface StepsNode {
    type: "steps";
    /**
     * @minItems 1
     */
    items: StepItem[];
  }
  export interface StepItem {
    title: NonEmptyString;
    /**
     * @minItems 1
     */
    content: SimpleContentNode[];
  }
  export interface FlowNode {
    type: "flow";
    title: NonEmptyString;
    description: NonEmptyString;
    /**
     * @minItems 1
     */
    nodes: FlowGraphNode[];
    edges: FlowGraphEdge[];
  }
  export interface FlowGraphNode {
    id: string;
    label: NonEmptyString;
    kind?: "start" | "step" | "decision" | "end";
  }
  export interface FlowGraphEdge {
    from: string;
    to: string;
    label?: NonEmptyString;
    kind?: "then" | "yes" | "no" | "else";
  }
  export interface ScaleNode {
    type: "scale";
    title: NonEmptyString;
    description: NonEmptyString;
    axis: ScaleAxis;
    /**
     * @minItems 2
     */
    items: ScaleItem[];
  }
  export interface ScaleAxis {
    lowLabel: NonEmptyString;
    highLabel: NonEmptyString;
  }
  export interface ScaleItem {
    label: NonEmptyString;
    position: number;
    display?: NonEmptyString;
    /**
     * @minItems 1
     */
    note?: InlineNode[];
  }
  export interface NextAction {
    id: ActionId;
    action: NonEmptyString;
    owner?: NonEmptyString;
    verification: NonEmptyString;
  }
  export interface EvidenceSnapshot {
    sourceHierarchy: SourceRef[];
    facts: FactItem[];
    decisions: SharedDecisionItem[];
    constraints: NonEmptyString[];
    risks: NonEmptyString[];
    openQuestions: NonEmptyString[];
    conflicts: EvidenceConflict[];
  }
  export interface SourceRef {
    id: SourceId;
    rank: number;
    label: NonEmptyString;
    reference: NonEmptyString;
    freshness: Freshness;
  }
  export interface StaticFreshness {
    kind: "static";
    checkedAt: ZonedDateTime;
  }
  export interface TimeSensitiveFreshness {
    kind: "time-sensitive";
    checkedAt: ZonedDateTime;
    expiresAt: ZonedDateTime;
  }
  export interface FactItem {
    id: FactId;
    /**
     * @minItems 1
     */
    content: ContentNode[];
    confidence: Confidence;
    /**
     * @minItems 1
     */
    sourceRefs: SourceId[];
  }
  export interface SharedDecisionItem {
    id: DecisionId;
    /**
     * @minItems 1
     */
    content: ContentNode[];
    confidence: Confidence;
    /**
     * @minItems 1
     */
    sourceRefs: SourceId[];
  }
  export interface EvidenceConflict {
    /**
     * @minItems 1
     */
    itemRefs: EvidenceItemId[];
    description: NonEmptyString;
    severity: "blocking" | "nonblocking";
    status: "resolved" | "unresolved";
    resolution?: NonEmptyString;
  }
  export interface TierTwoDecisionBlock {
    id: BlockId;
    tier: "T2";
    title: NonEmptyString;
    summary: NonEmptyString;
    /**
     * @minItems 1
     */
    body: ContentNode[];
    whyTier: NonEmptyString;
    ask: NonEmptyString;
    dependencies: BlockId[];
    claimRefs: FactId[];
    decisionRefs: DecisionId[];
    changed?: BlockChange;
  }
  export interface BlockChange {
    round: number;
    summary: NonEmptyString;
  }
  export interface StandardDecisionBlock {
    id: BlockId;
    tier: "T1" | "T0";
    title: NonEmptyString;
    summary: NonEmptyString;
    /**
     * @minItems 1
     */
    body: ContentNode[];
    whyTier?: NonEmptyString;
    ask?: NonEmptyString;
    dependencies: BlockId[];
    claimRefs: FactId[];
    decisionRefs: DecisionId[];
    changed?: BlockChange;
  }
  export interface GlossaryEntry {
    id: GlossaryId;
    term: NonEmptyString;
    definition: NonEmptyString;
  }
  export interface ApprovalSnapshot {
    history: ApprovalRecord[];
    currentFrozen: BlockId[];
  }
  export interface ApprovalRecord {
    blockId: BlockId;
    approvedRound: number;
    approvedContentDigest: Sha256Digest;
  }
  export interface Lineage {
    previousReviewDigest: null | Sha256Digest;
    idHighWater: DocumentIdHighWater;
    consumedPackets: ConsumedPacket[];
    topicMappings: TopicMapping[];
    impactAssessments: ImpactAssessment[];
    feedbackResolutions: FeedbackResolution[];
  }
  export interface DocumentIdHighWater {
    block: number;
    source: number;
    fact: number;
    decision: number;
    glossary: number;
    note: number;
    topic: number;
  }
  export interface ConsumedPacket {
    packetId: PacketId;
    semanticDigest: Sha256Digest;
  }
  export interface TopicMapping {
    topicId: TopicId;
    derivedDocumentId: DocumentId;
    derivedDeliveryId: DeliveryId;
  }
  export interface ImpactAssessment {
    upstreamBlockId: BlockId;
    changedAtRound: number;
    affectedDownstreamIds: BlockId[];
    reason: NonEmptyString;
    usedConservativeClosure: boolean;
  }
  export interface ContextFeedbackResolution {
    sourcePacketId: PacketId;
    feedbackId: FeedbackId;
    feedbackDigest: Sha256Digest;
    disposition: "context-only";
    reason: NonEmptyString;
  }
  export interface BlockFeedbackResolution {
    sourcePacketId: PacketId;
    feedbackId: FeedbackId;
    feedbackDigest: Sha256Digest;
    disposition: "converted-to-block";
    targetBlockId: BlockId;
    reason: NonEmptyString;
  }
}

export namespace ReviewPacketSchema {
  export type PacketId = string;
  export type Sha256Digest = string;
  export type DocumentId = string;
  export type NonEmptyString = string;
  export type ZonedDateTime = string;
  export type BlockId = string;
  export type PacketDecision = PassDecision | EditDecision | TopicDecision | HoldDecision;
  export type TopicId = string;
  export type NoteId = string;

  /**
   * Machine-authoritative approval receipt for review-packet/1.
   */
  export interface ReviewPacketV1 {
    format: "review-packet/1";
    packetId: PacketId;
    semanticDigest: Sha256Digest;
    doc: PacketDocumentIdentity;
    reviewedAt: ZonedDateTime;
    idHighWater: PacketIdHighWater;
    progress: PacketProgress;
    frozenCarried: BlockId[];
    reopened: BlockId[];
    decisions: PacketDecision[];
    sideNotes: PacketSideNote[];
    topics: PacketTopic[];
    overall?: NonEmptyString;
    stats: PacketStats;
  }
  export interface PacketDocumentIdentity {
    id: DocumentId;
    title: NonEmptyString;
    contentVersion: number;
    round: number;
    reviewDigest: Sha256Digest;
  }
  export interface PacketIdHighWater {
    block: number;
    source: number;
    fact: number;
    decision: number;
    glossary: number;
    note: number;
    topic: number;
  }
  export interface PacketProgress {
    decided: number;
    total: number;
    partial: boolean;
  }
  export interface PassDecision {
    blockId: BlockId;
    action: "PASS";
    quote?: NonEmptyString;
  }
  export interface EditDecision {
    blockId: BlockId;
    action: "EDIT";
    note: NonEmptyString;
    quote?: NonEmptyString;
  }
  export interface TopicDecision {
    blockId: BlockId;
    action: "TOPIC";
    topicId: TopicId;
    quote?: NonEmptyString;
  }
  export interface HoldDecision {
    blockId: BlockId;
    action: "HOLD";
    note: NonEmptyString;
    quote?: NonEmptyString;
  }
  export interface PacketSideNote {
    id: NoteId;
    blockId: BlockId;
    note: NonEmptyString;
  }
  export interface PacketTopic {
    id: TopicId;
    title: NonEmptyString;
    note?: NonEmptyString;
    sourceBlockId?: BlockId;
  }
  export interface PacketStats {
    PASS: number;
    EDIT: number;
    TOPIC: number;
    HOLD: number;
  }
}

export namespace ReviewStateSchema {
  export type DocumentId = string;
  export type Sha256Digest = string;
  export type ZonedDateTime = string;
  export type StateDecision =
    StatePassDecision | StateEditDecision | StateTopicDecision | StateHoldDecision;
  export type BlockId = string;
  export type NonEmptyString = string;
  export type TopicId = string;
  export type NoteId = string;

  /**
   * Recoverable, non-authorizing browser review state for review-state/1.
   */
  export interface ReviewStateV1 {
    format: "review-state/1";
    doc: StateDocumentIdentity;
    savedAt: ZonedDateTime;
    stateDigest: Sha256Digest;
    idHighWater: StateIdHighWater;
    decisions: StateDecision[];
    sideNotes: StateSideNote[];
    topics: StateTopic[];
    overall?: NonEmptyString;
    reopened: BlockId[];
  }
  export interface StateDocumentIdentity {
    id: DocumentId;
    contentVersion: number;
    round: number;
    reviewDigest: Sha256Digest;
  }
  export interface StateIdHighWater {
    block: number;
    source: number;
    fact: number;
    decision: number;
    glossary: number;
    note: number;
    topic: number;
  }
  export interface StatePassDecision {
    blockId: BlockId;
    action: "PASS";
    quote?: NonEmptyString;
  }
  export interface StateEditDecision {
    blockId: BlockId;
    action: "EDIT";
    note: NonEmptyString;
    quote?: NonEmptyString;
  }
  export interface StateTopicDecision {
    blockId: BlockId;
    action: "TOPIC";
    topicId: TopicId;
    quote?: NonEmptyString;
  }
  export interface StateHoldDecision {
    blockId: BlockId;
    action: "HOLD";
    note: NonEmptyString;
    quote?: NonEmptyString;
  }
  export interface StateSideNote {
    id: NoteId;
    blockId: BlockId;
    note: NonEmptyString;
  }
  export interface StateTopic {
    id: TopicId;
    title: NonEmptyString;
    note?: NonEmptyString;
    sourceBlockId?: BlockId;
  }
}

export type ReviewDocumentV1 = ReviewDocumentSchema.ReviewDocumentV1;
export type ReviewPacketV1 = ReviewPacketSchema.ReviewPacketV1;
export type ReviewStateV1 = ReviewStateSchema.ReviewStateV1;
