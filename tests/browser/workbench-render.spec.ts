import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  blockContentDigest,
  canonicalJson,
  computeReviewDigest,
  validateReviewDocument,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";

interface RenderCases {
  injectionText: string;
  externalLink: string;
  longToken: string;
}

let fixtureDirectory = "";
const pages = new Map<string, string>();
let renderCases: RenderCases;

function buildDocument(base: ReviewDocumentV1, cases: RenderCases): ReviewDocumentV1 {
  const input = structuredClone(base);
  input.document.uiLocale = "zh-CN";
  input.document.language = "en";
  input.document.title = cases.injectionText;
  input.document.summary = cases.longToken.repeat(4);
  input.document.round = 2;
  input.lineage.previousReviewDigest = `sha256:${"a".repeat(64)}`;
  input.continuation.objective = cases.injectionText;
  input.continuation.scope = ["UI-001 safe reading surface"];
  input.continuation.exclusions = ["No review actions yet"];
  input.continuation.currentState = [{
    type: "paragraph",
    content: [{ type: "text", text: `Current ${cases.injectionText}` }],
  }];
  input.continuation.nextActions = [{
    id: "ACT-001",
    action: "Verify self-contained evidence.",
    owner: cases.injectionText,
    verification: `Three browsers ${cases.injectionText}`,
  }];
  input.continuation.validationEvidence = ["Protocol core validated."];
  input.continuation.evidenceGaps = [cases.injectionText];
  input.evidence.sourceHierarchy.push({
    id: "SRC-002",
    rank: 2,
    label: `Time source ${cases.injectionText}`,
    reference: `https://not-a-link.invalid/${cases.injectionText}`,
    freshness: {
      kind: "time-sensitive",
      checkedAt: "2026-08-12T08:30:00Z",
      expiresAt: "2026-08-12T10:00:00Z",
    },
  });
  input.evidence.facts[0]!.content = [{
    type: "paragraph",
    content: [{ type: "text", text: `Fact ${cases.injectionText}` }],
  }];
  input.evidence.facts[0]!.sourceRefs.push("SRC-002");
  input.evidence.decisions = [{
    id: "D-001",
    content: [{
      type: "paragraph",
      content: [{ type: "text", text: `Decision ${cases.injectionText}` }],
    }],
    confidence: "medium",
    sourceRefs: ["SRC-002"],
  }];
  input.evidence.constraints = ["No network."];
  input.evidence.risks = [cases.injectionText];
  input.evidence.openQuestions = ["Does keyboard reading remain intact?"];
  input.evidence.conflicts = [{
    itemRefs: ["C-001", "D-001"],
    description: `Resolved conflict ${cases.injectionText}`,
    severity: "blocking",
    status: "resolved",
    resolution: `Use the verified contract ${cases.injectionText}`,
  }, {
    itemRefs: ["SRC-002"],
    description: "Observe freshness until expiry.",
    severity: "nonblocking",
    status: "unresolved",
  }];
  input.lineage.idHighWater.source = 2;
  input.lineage.idHighWater.decision = 1;
  input.glossary = [{ id: "G-001", term: "Closure", definition: "Every downstream dependency." }];
  input.lineage.idHighWater.glossary = 1;
  input.blocks[0]!.body = [
    {
      type: "paragraph",
      content: [
        { type: "text", text: `${cases.injectionText} ${cases.longToken.repeat(5)}` },
        { type: "link", text: " evidence", href: cases.externalLink },
        { type: "termRef", glossaryId: "G-001" },
      ],
    },
    {
      type: "table",
      headers: [[{ type: "text", text: "Long value" }]],
      rows: [[[{ type: "text", text: cases.longToken.repeat(4) }]]],
    },
    { type: "code", language: "html", text: cases.injectionText },
    {
      type: "callout",
      tone: "warning",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Visible warning" }] }],
    },
    {
      type: "flow",
      title: "Directed flow",
      description: "A safe visual plus an equivalent relationship list.",
      nodes: [
        { id: "A", label: "Alpha" },
        { id: "B", label: "Beta" },
        { id: "C", label: "Gamma" },
      ],
      edges: [
        { from: "A", to: "B", label: cases.injectionText },
        { from: "B", to: "A", label: "reverse" },
        { from: "C", to: "C", label: "loop" },
      ],
    },
  ];
  input.blocks[0]!.decisionRefs = ["D-001"];
  input.blocks[0]!.changed = { round: 2, summary: `Changed ${cases.injectionText}` };
  input.approvals.history = [{
    blockId: "B004",
    approvedRound: 1,
    approvedContentDigest: blockContentDigest(input.blocks[3]!),
  }];
  input.approvals.currentFrozen = ["B004"];
  const validated = validateReviewDocument(input);
  if (!validated.ok) throw new Error(validated.errors.map((error) => error.code).join(","));
  return validated.value;
}

function fillTemplate(
  template: string,
  documentValue: ReviewDocumentV1,
  encodedDocument: string,
  overrides: Readonly<Record<string, string>> = {},
): string {
  const digest = computeReviewDigest(documentValue);
  if (!digest.ok) throw new Error("review digest failed");
  const replacements: Record<string, string> = {
    "@@DAR_GENERATOR_VERSION@@": "0.2.0",
    "@@DAR_DOCUMENT_ID@@": documentValue.document.id,
    "@@DAR_CONTENT_VERSION@@": String(documentValue.document.contentVersion),
    "@@DAR_ROUND@@": String(documentValue.document.round),
    "@@DAR_REVIEW_DIGEST@@": digest.value,
    "@@DAR_DOCUMENT_BASE64@@": encodedDocument,
    ...overrides,
  };
  let html = template;
  for (const [token, value] of Object.entries(replacements)) {
    if (html.split(token).length !== 2) throw new Error(`bad generator token: ${token}`);
    html = html.replace(token, () => value);
  }
  if (html.includes("@@DAR_")) throw new Error("unresolved generator token");
  return html;
}

async function addPage(name: string, html: string): Promise<void> {
  const path = join(fixtureDirectory, `${name}.html`);
  await writeFile(path, html, "utf8");
  pages.set(name, pathToFileURL(path).href);
}

test.beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "dar-workbench-ui-001-"));
  const [template, rawBase, rawCases] = await Promise.all([
    readFile(
      resolve("skills/deliver-dual-audience-report/assets/review-workbench.template.html"),
      "utf8",
    ),
    readFile(resolve("tests/fixtures/protocol/review-document.json"), "utf8").then(JSON.parse),
    readFile(resolve("tests/fixtures/workbench/render-cases.json"), "utf8").then(JSON.parse),
  ]);
  const documentValue = buildDocument(rawBase as ReviewDocumentV1, rawCases as RenderCases);
  renderCases = rawCases as RenderCases;
  const encoded = Buffer.from(canonicalJson(documentValue), "utf8").toString("base64");
  const valid = fillTemplate(template, documentValue, encoded);
  await addPage("valid", valid);
  await addPage(
    "bad-base64",
    fillTemplate(template, documentValue, "A==="),
  );
  await addPage(
    "bad-utf8",
    fillTemplate(template, documentValue, Buffer.from([0xff]).toString("base64")),
  );
  await addPage(
    "bad-meta",
    fillTemplate(template, documentValue, encoded, { "@@DAR_GENERATOR_VERSION@@": "9.0.0" }),
  );
  const unsafeDocument = structuredClone(documentValue) as unknown as Record<string, unknown>;
  const blocks = unsafeDocument.blocks as Array<Record<string, unknown>>;
  const body = blocks[0]?.body as Array<Record<string, unknown>>;
  const content = body[0]?.content as Array<Record<string, unknown>>;
  const link = content.find((node) => node.type === "link");
  if (!link) throw new Error("link fixture missing");
  link.href = "javascript:globalThis.__DAR_INJECTED__=true";
  await addPage(
    "unsafe-url",
    fillTemplate(
      template,
      documentValue,
      Buffer.from(canonicalJson(unsafeDocument), "utf8").toString("base64"),
    ),
  );
  await addPage(
    "csp-tamper",
    valid.replace("</script>", ";globalThis.__DAR_CSP_TAMPERED__=true</script>"),
  );
  await addPage(
    "shell-tamper",
    valid.replace(
      '<header id="review-header">',
      '<h1>ATTACKER_VISIBLE</h1><form action="https://attacker.invalid"><a href="https://attacker.invalid">FAKE_FORM</a></form><header id="review-header">',
    ),
  );
});

test.afterAll(async () => {
  if (fixtureDirectory !== "") await rm(fixtureDirectory, { recursive: true });
});

function pageUrl(name: string): string {
  const value = pages.get(name);
  if (!value) throw new Error(`missing page fixture: ${name}`);
  return value;
}

test("@A19 render a safe offline shell with language and text alternatives", async ({ page }) => {
  const runtimeRequests: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const validUrl = pageUrl("valid");
  let initialNavigationSeen = false;
  page.on("request", (request) => {
    if (
      !initialNavigationSeen
      && request.resourceType() === "document"
      && request.url() === validUrl
    ) {
      initialNavigationSeen = true;
      return;
    }
    runtimeRequests.push(request.url());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(validUrl);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("article.decision-block")).toHaveCount(4);
  await expect(page.locator("a.skip-link")).toHaveText("跳到决策块");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("h1")).toHaveAttribute("lang", "en");
  await expect(page.locator("section.continuation")).toContainText("审批上下文");
  await expect(page.locator("section.continuation")).toContainText(renderCases.injectionText);
  await expect(page.locator("section.evidence p.evidence-notice")).toHaveText(
    "本工作台是对所列证据的综合，不是新的事实源；续作前请按来源层级复核易变事实。",
  );
  await expect(page.locator("#evidence-source-SRC-001 .freshness")).toContainText("静态来源");
  await expect(page.locator("#evidence-source-SRC-002 .freshness")).toContainText("易变来源");
  await expect(page.locator("#evidence-source-SRC-002 .freshness")).toContainText("失效时间");
  await expect(page.locator("#evidence-source-SRC-002 .source-reference")).toContainText(
    "https://not-a-link.invalid/",
  );
  await expect(page.locator("#evidence-source-SRC-002 a")).toHaveCount(0);
  await expect(page.locator("#evidence-fact-C-001")).toContainText("Fact");
  await expect(page.locator("#evidence-decision-D-001")).toContainText("Decision");
  await expect(page.locator(".conflict-state").nth(0)).toHaveText("阻断 · 已解决");
  await expect(page.locator(".conflict-state").nth(1)).toHaveText("非阻断 · 未解决");
  await expect(page.locator(".next-actions .content-value").first()).toHaveAttribute("lang", "en");
  await expect(page.locator(".next-actions p span").first()).not.toHaveAttribute("lang", "en");
  await expect(page.locator(".conflict-list .content-value")).toHaveAttribute("lang", "en");
  await expect(page.locator("article#block-B001 .block-body > div")).toHaveAttribute("lang", "en");
  await expect(page.locator(".callout-tone").first()).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".link-kind")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".callout-tone").first()).toContainText("警告");
  await expect(page.locator(".flow-arrow")).toHaveCount(3);
  await expect(page.locator(".flow-loop")).toHaveCount(1);
  await expect(page.locator(".flow-alternative")).toContainText("A → B");
  await expect(page.locator("a.term-ref")).toHaveAttribute("href", "#glossary-G-001");
  await expect(page.locator("#glossary-G-001")).toHaveCount(1);
  const termToggle = page.locator("button.term-disclosure-toggle");
  await expect(termToggle).toHaveAttribute("aria-expanded", "false");
  await termToggle.focus();
  await page.keyboard.press("Enter");
  await expect(termToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".term-definition")).toBeVisible();
  await expect(page.locator(".term-definition")).toContainText("Every downstream dependency.");
  const blockContext = page.locator("article#block-B001 details.block-context");
  await expect(blockContext).toContainText("D-001");
  await expect(blockContext).toContainText("本轮有变更");
  await blockContext.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(blockContext).toHaveAttribute("open", "");
  await expect(page.locator("article#block-B002 details.block-context")).toContainText("B001");
  const referenceAudit = await page.evaluate(() => {
    const ids = [...document.querySelectorAll<HTMLElement>("main [id]")].map((element) => element.id);
    const links = [...document.querySelectorAll<HTMLAnchorElement>("main a[data-internal-ref]")];
    return {
      idCount: ids.length,
      uniqueIdCount: new Set(ids).size,
      targets: links.map((link) => document.querySelectorAll(link.hash).length),
    };
  });
  expect(referenceAudit.uniqueIdCount).toBe(referenceAudit.idCount);
  expect(referenceAudit.targets.length).toBeGreaterThan(4);
  expect(referenceAudit.targets.every((count) => count === 1)).toBe(true);
  await expect(page.locator(".table-region")).toHaveAttribute("tabindex", "0");
  await expect(page.locator("article#block-B001 .code-region")).toHaveAttribute("tabindex", "0");
  await expect(page.locator("article#block-B001 details.block-body")).toHaveAttribute("open", "");
  await expect(page.locator("article#block-B002 details.block-body")).not.toHaveAttribute("open", "");
  const tierHierarchy = await page.evaluate(() => {
    const t0 = document.querySelector<HTMLElement>("article#block-B003");
    const t1 = document.querySelector<HTMLElement>("article#block-B002");
    if (t0 === null || t1 === null) {
      throw new Error("tier hierarchy fixture missing");
    }
    const t0Title = t0.querySelector<HTMLElement>("h3");
    const t1Title = t1.querySelector<HTMLElement>("h3");
    if (t0Title === null || t1Title === null) {
      throw new Error("tier hierarchy fixture missing");
    }
    return {
      t0Border: Number.parseFloat(getComputedStyle(t0).borderInlineStartWidth),
      t1Border: Number.parseFloat(getComputedStyle(t1).borderInlineStartWidth),
      t0Weight: Number.parseInt(getComputedStyle(t0Title).fontWeight, 10),
      t1Weight: Number.parseInt(getComputedStyle(t1Title).fontWeight, 10),
    };
  });
  expect(tierHierarchy.t0Border).toBeLessThan(tierHierarchy.t1Border);
  expect(tierHierarchy.t0Weight).toBeLessThan(tierHierarchy.t1Weight);
  const t0Body = page.locator("article#block-B003 details.block-body");
  await expect(t0Body).not.toHaveAttribute("open", "");
  await t0Body.locator("summary").click();
  await expect(t0Body).toHaveAttribute("open", "");
  await expect(page.locator("article#block-B004 .status-chip")).toHaveText("❄ 已冻结 · 冻结轮次: 1");
  await expect(page.locator(".decision-action[aria-pressed='true']")).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as typeof globalThis & {
    __DAR_INJECTED__?: boolean;
  }).__DAR_INJECTED__ ?? false)).toBe(false);
  expect(await page.evaluate(() => document.querySelectorAll("script").length)).toBe(1);
  expect(await page.evaluate(() => document.querySelectorAll("img").length)).toBe(0);
  expect(runtimeRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("a11y-shell has no serious axe violations in blocking browsers", async ({ page, browserName }) => {
  test.skip(browserName === "firefox", "Firefox is the Design §14 smoke lane");
  await page.goto(pageUrl("valid"));
  await expect(page.locator("h1")).toHaveCount(1);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
});

test("a11y-shell keeps focus visible and the 320px page free of horizontal overflow", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(pageUrl("valid"));
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(page.locator("a.skip-link")).toBeFocused();
  const focus = await page.locator("a.skip-link").evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineWidth: Number.parseFloat(style.outlineWidth), transform: style.transform };
  });
  expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(focus.transform).toBe("none");
  await page.keyboard.press("Enter");
  await expect(page.locator("main#review-main")).toBeFocused();
  const mainOutline = await page.locator("main#review-main").evaluate((element) => (
    Number.parseFloat(getComputedStyle(element).outlineWidth)
  ));
  expect(mainOutline).toBeGreaterThanOrEqual(2);
  const widths = await page.evaluate(() => ({
    bodyClient: document.body.clientWidth,
    bodyScroll: document.body.scrollWidth,
    htmlClient: document.documentElement.clientWidth,
    htmlScroll: document.documentElement.scrollWidth,
  }));
  expect(widths.bodyScroll).toBeLessThanOrEqual(widths.bodyClient);
  expect(widths.htmlScroll).toBeLessThanOrEqual(widths.htmlClient);
  const localScroll = await page.locator(".table-region").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(localScroll.scroll).toBeGreaterThan(localScroll.client);
  const codeScroll = await page.locator("article#block-B001 .code-region").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
    label: element.getAttribute("aria-label"),
    tabIndex: (element as HTMLElement).tabIndex,
    lang: element.getAttribute("lang"),
    contentLang: element.querySelector("pre")?.getAttribute("lang"),
  }));
  expect(codeScroll.scroll).toBeGreaterThan(codeScroll.client);
  expect(codeScroll.label).toBe("可横向滚动的代码");
  expect(codeScroll.tabIndex).toBe(0);
  expect(codeScroll.lang).toBe("zh-CN");
  expect(codeScroll.contentLang).toBe("en");
});

test("@A19 fail closed for payload, identity, URL, and CSP tampering", async ({ page, browserName }) => {
  const runtimeRequests: string[] = [];
  let allowedNavigation = "";
  let initialNavigationSeen = false;
  page.on("request", (request) => {
    if (
      !initialNavigationSeen
      && request.resourceType() === "document"
      && request.url() === allowedNavigation
    ) {
      initialNavigationSeen = true;
      return;
    }
    runtimeRequests.push(request.url());
  });
  for (const [name, code] of [
    ["bad-base64", "DOCUMENT_BASE64_INVALID"],
    ["bad-utf8", "DOCUMENT_UTF8_INVALID"],
    ["bad-meta", "META_IDENTITY_MISMATCH"],
    ["unsafe-url", "SCHEMA_"],
  ] as const) {
    runtimeRequests.length = 0;
    allowedNavigation = pageUrl(name);
    initialNavigationSeen = false;
    await page.goto(allowedNavigation);
    await expect(page.locator(".error-panel")).toContainText(code);
    await expect(page.locator("article")).toHaveCount(0);
    expect(runtimeRequests).toEqual([]);
  }

  const cspErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") cspErrors.push(message.text());
  });
  runtimeRequests.length = 0;
  allowedNavigation = pageUrl("csp-tamper");
  initialNavigationSeen = false;
  await page.goto(allowedNavigation);
  await page.waitForLoadState("load");
  expect(await page.evaluate(() => (globalThis as typeof globalThis & {
    __DAR_CSP_TAMPERED__?: boolean;
  }).__DAR_CSP_TAMPERED__ ?? false)).toBe(false);
  await expect(page.locator("article")).toHaveCount(0);
  expect(runtimeRequests).toEqual([]);
  if (browserName !== "firefox") {
    expect(cspErrors.some((message) => message.includes("Content Security Policy"))).toBe(true);
  }

  runtimeRequests.length = 0;
  allowedNavigation = pageUrl("shell-tamper");
  initialNavigationSeen = false;
  await page.goto(allowedNavigation);
  await expect(page.locator("main .error-panel[role=alert]")).toContainText("SHELL_HEADING_INVALID");
  await expect(page.locator("body")).not.toContainText("ATTACKER_VISIBLE");
  await expect(page.locator("body")).not.toContainText("FAKE_FORM");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("form,a")).toHaveCount(0);
  expect(runtimeRequests).toEqual([]);
});
