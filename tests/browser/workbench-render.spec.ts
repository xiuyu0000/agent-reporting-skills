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
  input.glossary = [
    { id: "G-001", term: "Closure", definition: "Every downstream dependency." },
    {
      id: "G-002",
      term: "Blocking gate",
      // Long enough that a clipped preview is unmistakably truncated.
      definition: "A check that must pass before a change may merge. It runs in "
        + "continuous integration and cannot be waived by the author.",
    },
  ];
  input.lineage.idHighWater.glossary = 2;
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
      headers: [
        [{ type: "text", text: "Long value" }],
        [{ type: "text", text: "Gate (" }, { type: "termRef", glossaryId: "G-002" }, { type: "text", text: ")" }],
      ],
      rows: [[
        [{ type: "text", text: cases.longToken.repeat(4) }],
        [{ type: "termRef", glossaryId: "G-002", text: "first row term" }],
      ]],
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
        { id: "A", label: "Alpha", kind: "start" },
        { id: "B", label: "Beta", kind: "decision" },
        { id: "C", label: "Gamma" },
      ],
      edges: [
        { from: "A", to: "B", label: cases.injectionText },
        { from: "B", to: "A", label: "reverse", kind: "no" },
        { from: "C", to: "C", label: "loop" },
      ],
    },
    {
      type: "scale",
      title: "Carrier strength",
      description: "How reliably each carrier holds a rule.",
      axis: { lowLabel: "weakest", highLabel: "strongest" },
      items: [
        { label: "Spoken", position: 0, display: "lowest" },
        { label: "Checked", position: 100 },
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
  await expect(page.locator("article.blk")).toHaveCount(4);
  await expect(page.locator("a.skip-link")).toHaveText("跳到决策块");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("h1")).toHaveAttribute("lang", "en");
  await expect(page.locator("details.context-fold > summary").first()).toContainText("审批上下文");
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
  await expect(page.locator("article#block-B001 .b-body > .b-content")).toHaveAttribute("lang", "en");
  await expect(page.locator(".callout-tone").first()).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".link-kind")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".callout-tone").first()).toContainText("警告");
  await expect(page.locator(".flow-arrow")).toHaveCount(3);
  await expect(page.locator(".flow-loop")).toHaveCount(1);
  // The text alternative speaks node labels, not local ids (design §11.3/§7.3).
  await expect(page.locator(".flow-alternative")).toContainText("Alpha → Beta");
  await expect(page.locator(".flow-alternative")).not.toContainText("A → B");
  // Collision-aware placement: no label falls back to a crowded position.
  await expect(page.locator(".flow-label-box.crowded")).toHaveCount(0);
  // Node kind drives shape, and the same kind is stated as a word so shape is
  // never the only channel (spec §13.5).
  await expect(page.locator("polygon.flow-node-decision")).toHaveCount(1);
  await expect(page.locator("rect.flow-node-start")).toHaveCount(1);
  await expect(page.locator(".flow-alternative")).toContainText("Beta (判断)");
  // The ranked scale renders as real text plus a proportional bar.
  const scale = page.locator("figure.scale");
  await expect(scale.locator("li")).toHaveCount(2);
  await expect(scale).toContainText("weakest → strongest");
  await expect(scale).toContainText("100/100");
  // Proportional, not merely present: /\d/ also matches "0px".
  const fills = await scale.locator(".scale-fill").evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().width));
  expect(fills).toHaveLength(2);
  expect(fills[0]).toBeLessThan(2);
  expect(fills[1]).toBeGreaterThan(40);
  expect(fills[1]).toBeGreaterThan((fills[0] ?? 0) * 10);
  // One anchor per term: hover/focus previews the definition (data-tip),
  // activating jumps to the in-file glossary appendix. No expand button.
  const termRef = page.locator('a.term-ref[href="#glossary-G-001"]');
  await expect(termRef).toHaveAttribute("href", "#glossary-G-001");
  await expect(termRef).toHaveAttribute("data-tip", "Every downstream dependency.");
  await expect(page.locator("#glossary-G-001")).toHaveCount(1);
  await expect(page.locator("button.term-disclosure-toggle")).toHaveCount(0);
  await termRef.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#glossary-G-001")).toBeInViewport();
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
  await expect(page.locator("article#block-B001 details.b-body")).toHaveAttribute("open", "");
  await expect(page.locator("article#block-B002 details.b-body")).not.toHaveAttribute("open", "");
  const tierHierarchy = await page.evaluate(() => {
    const read = (selector: string) => {
      const article = document.querySelector<HTMLElement>(selector);
      const title = article?.querySelector<HTMLElement>("h3.b-title");
      const pill = article?.querySelector<HTMLElement>("span.pill");
      if (article === null || article === undefined || title == null || pill == null) {
        throw new Error("tier hierarchy fixture missing");
      }
      return {
        border: getComputedStyle(article).borderInlineStartColor,
        width: Number.parseFloat(getComputedStyle(article).borderInlineStartWidth),
        weight: Number.parseInt(getComputedStyle(title).fontWeight, 10),
        pill: pill.textContent ?? "",
      };
    };
    return {
      t0: read("article#block-B003"),
      t1: read("article#block-B002"),
      t2: read("article#block-B001"),
    };
  });
  expect(new Set([
    tierHierarchy.t0.border,
    tierHierarchy.t1.border,
    tierHierarchy.t2.border,
  ]).size).toBe(3);
  expect(tierHierarchy.t0.width).toBeGreaterThanOrEqual(4);
  expect(tierHierarchy.t0.weight).toBeLessThan(tierHierarchy.t1.weight);
  expect(tierHierarchy.t1.weight).toBeLessThan(tierHierarchy.t2.weight);
  expect([tierHierarchy.t0.pill, tierHierarchy.t1.pill, tierHierarchy.t2.pill])
    .toEqual(["T0 直行", "T1 知会", "T2 决策"]);
  const t0Body = page.locator("article#block-B003 details.b-body");
  await expect(t0Body).not.toHaveAttribute("open", "");
  await t0Body.locator("summary").click();
  await expect(t0Body).toHaveAttribute("open", "");
  await expect(page.locator("article#block-B004 .frozen-chip")).toHaveText("❄ 已冻结 · 冻结轮次: 1");
  await expect(page.locator(".act[aria-pressed='true']")).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as typeof globalThis & {
    __DAR_INJECTED__?: boolean;
  }).__DAR_INJECTED__ ?? false)).toBe(false);
  expect(await page.evaluate(() => document.querySelectorAll("script").length)).toBe(1);
  expect(await page.evaluate(() => document.querySelectorAll("img").length)).toBe(0);
  expect(runtimeRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("@A19 the approved workbench visual system drives tier, decision, and progress chrome", async ({ page }) => {
  await page.goto(pageUrl("valid"));
  await expect(page.locator("article.blk")).toHaveCount(4);

  // The approved palette is the contract; a drifted token changes every card,
  // chip and bar at once, so it is asserted exactly.
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string): string => style.getPropertyValue(name).trim();
    return {
      page: read("--page"),
      surface: read("--surface"),
      ink: read("--ink"),
      ink2: read("--ink2"),
      muted: read("--muted"),
      hair: read("--hair"),
      base: read("--base"),
      ring: read("--ring"),
      blue: read("--blue"),
      orange: read("--orange"),
      aqua: read("--aqua"),
      yellow: read("--yellow"),
      magenta: read("--magenta"),
      violet: read("--violet"),
      good: read("--good"),
      serious: read("--serious"),
      critical: read("--critical"),
    };
  });
  expect(tokens).toEqual({
    page: "#f9f9f7",
    surface: "#fcfcfb",
    ink: "#0b0b0b",
    ink2: "#52514e",
    muted: "#898781",
    hair: "#e1e0d9",
    base: "#c3c2b7",
    ring: "rgba(11,11,11,.10)",
    blue: "#2a78d6",
    orange: "#eb6834",
    aqua: "#1baf7a",
    yellow: "#eda100",
    magenta: "#e87ba4",
    violet: "#4a3aa7",
    good: "#0ca30c",
    serious: "#ec835a",
    critical: "#d03b3b",
  });

  const resolveToken = async (name: string): Promise<string> => page.evaluate((token) => {
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(token);
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
  const borderOf = async (selector: string): Promise<string> => page.locator(selector)
    .evaluate((element) => getComputedStyle(element).borderLeftColor);

  // color-mix() drives every tint in this stylesheet; a browser that dropped it
  // would leave the pill unpainted.
  const pillBackground = await page.locator("article#block-B001 .pill")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(pillBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(pillBackground).not.toBe("transparent");

  // Tier first: T2 orange, T1 blue, T0 base.
  expect(await borderOf("article#block-B001")).toBe(await resolveToken("--orange"));
  expect(await borderOf("article#block-B002")).toBe(await resolveToken("--blue"));
  expect(await borderOf("article#block-B003")).toBe(await resolveToken("--base"));

  // Then the decision replaces it, and the pressed chip is tinted.
  await page.locator("article#block-B002 button[data-action='PASS']").click();
  await expect(page.locator("article#block-B002")).toHaveClass(/(^|\s)st-PASS(\s|$)/);
  expect(await borderOf("article#block-B002")).toBe(await resolveToken("--good"));
  const passChip = page.locator("article#block-B002 button[data-action='PASS']");
  await expect(passChip).toHaveAttribute("aria-pressed", "true");
  await expect(passChip).toHaveClass(/(^|\s)on(\s|$)/);
  const chipBackground = await passChip.evaluate((element) => getComputedStyle(element).backgroundColor);
  const restingChipBackground = await page.locator("article#block-B002 button[data-action='HOLD']")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(chipBackground).not.toBe(restingChipBackground);

  await page.locator("article#block-B003 button[data-action='HOLD']").click();
  await page.locator("dialog[open] textarea").fill("Answer this before deciding.");
  await page.locator("dialog[open] button.dialog-save").click();
  expect(await borderOf("article#block-B003")).toBe(await resolveToken("--serious"));

  // The progress element is a real fill bar, not a sentence.
  const progress = await page.locator(".progress > i").evaluate((element) => ({
    tag: element.tagName,
    fill: element.getBoundingClientRect().width,
    track: (element.parentElement as HTMLElement).getBoundingClientRect().width,
    colour: getComputedStyle(element).backgroundColor,
  }));
  expect(progress.tag).toBe("I");
  expect(progress.fill).toBeGreaterThan(0);
  expect(progress.fill).toBeLessThan(progress.track);
  expect(progress.colour).toBe(await resolveToken("--blue"));
  await expect(page.locator(".progress")).toHaveAttribute("aria-valuenow", "2");
  await expect(page.locator(".progress")).toHaveAttribute("aria-valuemax", "3");
  await expect(page.locator(".p-num")).toHaveText("2 共 3");

  // Filter pills invert on the active one instead of using a select.
  await expect(page.locator("#review-filter button[data-filter='all']"))
    .toHaveClass(/(^|\s)on(\s|$)/);
  await page.locator("#review-filter button[data-filter='t2']").click();
  await expect(page.locator("#review-filter button[data-filter='t2']"))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#review-filter button[data-filter='all']"))
    .toHaveAttribute("aria-pressed", "false");
  const activeFilter = await page.locator("#review-filter button[data-filter='t2']")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(activeFilter).toBe(await resolveToken("--ink"));

  // The 340px rail and the 1280px reading column are the approved layout.
  const layout = await page.locator("div.layout").evaluate((element) => ({
    columns: getComputedStyle(element).gridTemplateColumns,
    maxWidth: getComputedStyle(element).maxWidth,
  }));
  expect(layout.columns.split(" ").at(-1)).toBe("340px");
  expect(layout.maxWidth).toBe("1280px");
});

test("@A19 the glossary preview escapes every scroll container that used to clip it", async ({ page }) => {
  await page.goto(pages.get("valid") ?? "");
  await page.locator("details.b-body").first().evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });

  // The reported failure position: a term inside a table, whose wrapper carries
  // overflow-x:auto and therefore also clips the block axis.
  const terms = page.locator('.table-region a.term-ref[href="#glossary-G-002"]');
  const count = await terms.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const term = terms.nth(index);
    await term.scrollIntoViewIfNeeded();
    // The page scrolls smoothly; hover only once it has settled, so the probe
    // measures a resting position rather than an animating one.
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await term.hover();
    await expect(page.locator("#term-tip")).toBeVisible();
    const report = await page.evaluate((position) => {
      const tip = document.getElementById("term-tip");
      const anchor = document.querySelectorAll(
        '.table-region a.term-ref[href="#glossary-G-002"]',
      )[position];
      if (tip === null || anchor === undefined) return null;
      const rect = tip.getBoundingClientRect();
      const root = document.documentElement;
      // Sample well inside the rounded corners: every probe must land on the
      // preview itself, which is only possible if nothing clipped or covered it.
      const probes: [number, number][] = [];
      for (const fx of [0.15, 0.5, 0.85]) {
        for (const fy of [0.2, 0.5, 0.8]) {
          probes.push([rect.x + rect.width * fx, rect.y + rect.height * fy]);
        }
      }
      const hits = probes.filter(([x, y]) => {
        const found = document.elementFromPoint(x, y);
        return found === tip || tip.contains(found);
      }).length;
      return {
        hits,
        probes: probes.length,
        withinViewport: rect.x >= 0 && rect.y >= 0
          && rect.right <= root.clientWidth && rect.bottom <= root.clientHeight,
        text: tip.textContent ?? "",
        describedBy: anchor.getAttribute("aria-describedby"),
      };
    }, index);
    expect(report).not.toBeNull();
    expect(report?.hits).toBe(report?.probes);
    expect(report?.withinViewport).toBe(true);
    expect(report?.describedBy).toBe("term-tip");
    // The whole definition, not a clipped fragment.
    expect(report?.text).toContain("cannot be waived by the author.");
  }

  // Escape dismisses the preview without disturbing the block keyboard contract.
  await page.keyboard.press("Escape");
  await expect(page.locator("#term-tip")).toBeHidden();

  // The wide table still scrolls inside its own focusable container.
  await expect(page.locator("div.table-region").first()).toHaveAttribute("tabindex", "0");
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
