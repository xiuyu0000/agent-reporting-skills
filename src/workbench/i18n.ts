export const SUPPORTED_UI_LOCALES = ["zh-CN", "en"] as const;

export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

const en = {
  approvalWorkspace: "Approval workspace",
  asOf: "Facts as of",
  blockContext: "Dependencies, evidence, and changes",
  blocking: "Blocking",
  changed: "Changed this round",
  changedRound: "Changed in round",
  checkedAt: "Checked at",
  claimReferences: "Fact references",
  confidence: "Confidence",
  confidenceHigh: "High",
  confidenceLow: "Low",
  confidenceMedium: "Medium",
  confidenceUnknown: "Unknown",
  conflicts: "Evidence conflicts",
  constraints: "Constraints",
  continuation: "Review context",
  currentState: "Current state",
  decisionBlocks: "Decision blocks",
  decisionReferences: "Decision references",
  decisions: "Established decisions",
  decisionRail: "Decision rail",
  dependencies: "Dependencies",
  evidenceNotice:
    "This workspace synthesizes the listed evidence; it is not a new source of truth. Before continuing, recheck time-sensitive facts according to the source hierarchy.",
  evidence: "Evidence snapshot",
  evidenceGaps: "Evidence gaps",
  exclusions: "Out of scope",
  expiresAt: "Expires at",
  extensionReading: "Extension reading",
  facts: "Core facts",
  freshness: "Freshness",
  flowConnections: "Flow connections",
  flowTextAlternative: "Text alternative",
  frozen: "Frozen",
  frozenRound: "Frozen in round",
  glossary: "Glossary",
  glossaryJump: "Go to glossary",
  hideDefinition: "Hide definition",
  keyboardHelp:
    "Keyboard review actions will be enabled in the next workbench stage.",
  loading: "Loading review document…",
  nextActions: "Proposed next actions",
  noDecisionTools:
    "Review actions, notes, state recovery, and exports are added in the next implementation stages.",
  none: "None",
  nonblocking: "Nonblocking",
  objective: "Objective",
  of: "of",
  openQuestions: "Open questions",
  owner: "Owner",
  reference: "Source reference",
  resolution: "Resolution",
  resolved: "Resolved",
  risks: "Risks",
  round: "Round",
  securityError: "The review document could not be loaded safely.",
  skipToMain: "Skip to decision blocks",
  status: "Status",
  statusDraft: "Draft",
  statusFinalized: "Finalized",
  statusInReview: "In review",
  showDefinition: "Show definition",
  scope: "In scope",
  sourceHierarchy: "Source hierarchy",
  sourceReferences: "Source references",
  sourceRank: "Rank",
  staticSource: "Static source",
  summary: "Summary",
  tableRegion: "Scrollable table",
  codeRegion: "Scrollable code",
  calloutDecision: "Decision note",
  calloutInfo: "Information",
  calloutWarning: "Warning",
  tierCounts: "Decision tier counts",
  tierT0: "T0 routine",
  tierT1: "T1 notice",
  tierT2: "T2 decision",
  timeSensitiveSource: "Time-sensitive source",
  unresolved: "Unresolved",
  validationEvidence: "Validation evidence",
  verification: "Verification",
  whyTier: "Why your decision is needed",
  ask: "Question for you",
} as const;

type LocaleKey = keyof typeof en;
type LocaleTable = { readonly [Key in LocaleKey]: string };

const zhCN = {
  approvalWorkspace: "审批工作台",
  asOf: "事实截止时间",
  blockContext: "依赖、证据与变更",
  blocking: "阻断",
  changed: "本轮有变更",
  changedRound: "变更轮次",
  checkedAt: "核验时间",
  claimReferences: "事实引用",
  confidence: "置信度",
  confidenceHigh: "高",
  confidenceLow: "低",
  confidenceMedium: "中",
  confidenceUnknown: "未知",
  conflicts: "证据冲突",
  constraints: "约束",
  continuation: "审批上下文",
  currentState: "当前状态",
  decisionBlocks: "决策块",
  decisionReferences: "决定引用",
  decisions: "既定决定",
  decisionRail: "审批侧栏",
  dependencies: "依赖",
  evidenceNotice: "本工作台是对所列证据的综合，不是新的事实源；续作前请按来源层级复核易变事实。",
  evidence: "证据快照",
  evidenceGaps: "证据缺口",
  exclusions: "排除项",
  expiresAt: "失效时间",
  extensionReading: "延伸阅读",
  facts: "核心事实",
  freshness: "新鲜度",
  flowConnections: "流程连接关系",
  flowTextAlternative: "文字等价说明",
  frozen: "已冻结",
  frozenRound: "冻结轮次",
  glossary: "术语表",
  glossaryJump: "跳到术语表",
  hideDefinition: "收起定义",
  keyboardHelp: "键盘审批动作将在下一工作台阶段启用。",
  loading: "正在加载审批文档…",
  nextActions: "建议下一步",
  noDecisionTools: "审批动作、随手记、状态恢复与导出将在后续实施阶段加入。",
  none: "无",
  nonblocking: "非阻断",
  objective: "目标",
  of: "共",
  openQuestions: "开放问题",
  owner: "负责人",
  reference: "来源定位",
  resolution: "解决说明",
  resolved: "已解决",
  risks: "风险",
  round: "轮次",
  securityError: "审批文档无法安全加载。",
  skipToMain: "跳到决策块",
  status: "状态",
  statusDraft: "草案",
  statusFinalized: "已定稿",
  statusInReview: "审批中",
  showDefinition: "展开定义",
  scope: "范围",
  sourceHierarchy: "来源层级",
  sourceReferences: "来源引用",
  sourceRank: "层级",
  staticSource: "静态来源",
  summary: "摘要",
  tableRegion: "可横向滚动的表格",
  codeRegion: "可横向滚动的代码",
  calloutDecision: "决策提示",
  calloutInfo: "信息提示",
  calloutWarning: "警告",
  tierCounts: "决策层级统计",
  tierT0: "T0 直行",
  tierT1: "T1 知会",
  tierT2: "T2 决策",
  timeSensitiveSource: "易变来源",
  unresolved: "未解决",
  validationEvidence: "验证证据",
  verification: "验证方式",
  whyTier: "为什么需要你拍板",
  ask: "希望你回答",
} as const satisfies LocaleTable;

const LOCALE_TABLES: Readonly<Record<UiLocale, LocaleTable>> = {
  "zh-CN": zhCN,
  en,
};

export function isUiLocale(value: string): value is UiLocale {
  return (SUPPORTED_UI_LOCALES as readonly string[]).includes(value);
}

export function stringsFor(locale: UiLocale): LocaleTable {
  return LOCALE_TABLES[locale];
}

export function assertCompleteLocaleTables(): void {
  const expected = Object.keys(en).sort();
  for (const locale of SUPPORTED_UI_LOCALES) {
    const actual = Object.keys(LOCALE_TABLES[locale]).sort();
    if (
      actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])
    ) {
      throw new Error("LOCALE_TABLE_INCOMPLETE");
    }
  }
}

assertCompleteLocaleTables();

export type WorkbenchStrings = LocaleTable;
