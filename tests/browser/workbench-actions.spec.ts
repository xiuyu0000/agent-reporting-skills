import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  blockContentDigest,
  canonicalJson,
  computeReviewDigest,
  validateReviewDocument,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";

let fixtureDirectory = "";
let workbenchUrl = "";
let frozenWorkbenchUrl = "";

function fillTemplate(template: string, documentValue: ReviewDocumentV1): string {
  const digest = computeReviewDigest(documentValue);
  if (!digest.ok) throw new Error("review digest failed");
  const replacements: Readonly<Record<string, string>> = {
    "@@DAR_GENERATOR_VERSION@@": "0.2.0",
    "@@DAR_DOCUMENT_ID@@": documentValue.document.id,
    "@@DAR_CONTENT_VERSION@@": String(documentValue.document.contentVersion),
    "@@DAR_ROUND@@": String(documentValue.document.round),
    "@@DAR_REVIEW_DIGEST@@": digest.value,
    "@@DAR_DOCUMENT_BASE64@@": Buffer.from(canonicalJson(documentValue), "utf8").toString("base64"),
  };
  let html = template;
  for (const [token, value] of Object.entries(replacements)) {
    if (html.split(token).length !== 2) throw new Error(`bad generator token: ${token}`);
    html = html.replace(token, () => value);
  }
  if (html.includes("@@DAR_")) throw new Error("unresolved generator token");
  return html;
}

test.beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "dar-workbench-ui-002-"));
  const [template, rawDocument] = await Promise.all([
    readFile(
      resolve("skills/deliver-dual-audience-report/assets/review-workbench.template.html"),
      "utf8",
    ),
    readFile(resolve("tests/fixtures/protocol/review-document.json"), "utf8").then(JSON.parse),
  ]);
  const documentValue = rawDocument as ReviewDocumentV1;
  documentValue.document.uiLocale = "zh-CN";
  const validated = validateReviewDocument(documentValue);
  if (!validated.ok) throw new Error(validated.errors.map((error) => error.code).join(","));
  const path = join(fixtureDirectory, "actions.html");
  await writeFile(path, fillTemplate(template, validated.value), "utf8");
  workbenchUrl = pathToFileURL(path).href;

  const frozenDocument = structuredClone(validated.value);
  const frozenBlock = frozenDocument.blocks.find((block) => block.id === "B004");
  if (frozenBlock === undefined) throw new Error("frozen fixture block missing");
  frozenDocument.approvals.history = [{
    blockId: frozenBlock.id,
    approvedRound: frozenDocument.document.round,
    approvedContentDigest: blockContentDigest(frozenBlock),
  }];
  frozenDocument.approvals.currentFrozen = [frozenBlock.id];
  const frozenValidated = validateReviewDocument(frozenDocument);
  if (!frozenValidated.ok) {
    throw new Error(frozenValidated.errors.map((error) => error.code).join(","));
  }
  const frozenPath = join(fixtureDirectory, "frozen-actions.html");
  await writeFile(frozenPath, fillTemplate(template, frozenValidated.value), "utf8");
  frozenWorkbenchUrl = pathToFileURL(frozenPath).href;
});

test.afterAll(async () => {
  if (fixtureDirectory !== "") await rm(fixtureDirectory, { recursive: true });
});

async function openWorkbench(page: Page, url = workbenchUrl, total = 4): Promise<void> {
  // The template scrolls smoothly (html{scroll-behavior:smooth}) and WebKit's
  // automation scroll honours that, so a click needing a page scroll can be
  // dispatched while the target is still gliding and silently miss it. Forcing
  // instant scrolling through CSSOM keeps pointer targets still; the CSP style
  // hash rejects an injected <style>, so the inline property is the only route.
  await page.addInitScript(() => {
    const neutralizeSmoothScroll = (): void => {
      document.documentElement.style.scrollBehavior = "auto";
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", neutralizeSmoothScroll);
    } else {
      neutralizeSmoothScroll();
    }
  });
  await page.goto(url);
  await expect(page.locator("article.blk")).toHaveCount(4);
  await expect(page.locator(".p-num")).toContainText(`0 共 ${total}`);
}

// Option A keeps the rail compact: each editor sits in a closed disclosure, so a
// reviewer opens it exactly as they would in the approved prototype.
async function openRailEditor(page: Page, controlId: string): Promise<void> {
  const fold = page.locator(`details.rail-fold:has(#${controlId})`);
  if (!(await fold.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await fold.locator("summary").click();
  }
}

function block(page: Page, blockId: string) {
  return page.locator(`article#block-${blockId}`);
}

test("@A01 interaction mount preserves the self-contained reader shell", async ({ page }) => {
  await openWorkbench(page);
  await expect(page.locator("section.continuation")).toHaveCount(1);
  await expect(page.locator("section.evidence")).toHaveCount(1);
  await expect(page.locator("aside#decision-rail > h2#decision-rail-heading")).toHaveCount(1);
  await expect(page.locator("aside#decision-rail > p")).toContainText("无需离开文档");
  await expect(page.locator("aside#decision-rail > section.review-interactions")).toHaveCount(1);
  await expect(page.locator("footer#review-footer")).toContainText("j/k");
});

test("@A03 bulk confirmation passes only pending T0/T1 blocks", async ({ page }) => {
  await openWorkbench(page);
  const bulk = page.getByRole("button", { name: /整批通过 T0\/T1/ });
  await expect(bulk).toHaveText("整批通过 T0/T1 (3)");
  await bulk.click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toContainText("将通过的块: 3 · T0 2 · T1 1");
  await expect(dialog).toContainText("T2 已排除且保持不变: 1");
  await dialog.getByRole("button", { name: "确认整批通过" }).click();

  await expect(block(page, "B001").locator(".st-chip")).toContainText("待处理");
  for (const blockId of ["B002", "B003", "B004"]) {
    await expect(block(page, blockId).locator(".st-chip")).toContainText("通过");
    await expect(block(page, blockId).locator("button[data-action='PASS']"))
      .toHaveAttribute("aria-pressed", "true");
  }
  await expect(page.locator(".p-num")).toContainText("3 共 4");
  await expect(page.locator(".review-feedback")).toContainText("T2 已排除且保持不变: 1");
  await expect(block(page, "B001")).toBeFocused();

  await page.reload();
  for (const blockId of ["B002", "B003", "B004"]) {
    await expect(block(page, blockId).locator(".st-chip")).toContainText("通过");
  }
  for (const blockId of ["B003", "B004"]) {
    await block(page, blockId).getByRole("button", { name: "撤销决定" }).click();
    await expect(block(page, blockId).locator(".st-chip")).toContainText("待处理");
  }
  await block(page, "B002").locator("button[data-action='EDIT']").click();
  await page.locator("dialog textarea").fill("Do not pass this block in bulk.");
  await page.locator("dialog").getByRole("button", { name: "保存" }).click();
  await expect(bulk).toHaveText("整批通过 T0/T1 (2)");
  await bulk.click();
  await expect(dialog).toContainText("将通过的块: 2 · T0 2 · T1 0");
  await dialog.getByRole("button", { name: "确认整批通过" }).click();
  await expect(block(page, "B002").locator(".st-chip")).toContainText("修改");
  await expect(block(page, "B001").locator(".st-chip")).toContainText("待处理");

  await page.locator("#review-filter button[data-filter='t2']").click();
  await expect(block(page, "B001")).toBeVisible();
  await expect(block(page, "B002")).toBeHidden();
  await expect(bulk).toBeDisabled();
});

test("@A16 shared execution eligibility propagates through the dependency chain", async ({ page }) => {
  await openWorkbench(page);
  await expect(page.locator(".execution-eligibility[data-eligibility='suspended']")).toHaveCount(4);

  for (const blockId of ["B001", "B002", "B003", "B004"]) {
    await block(page, blockId).locator("button[data-action='PASS']").click();
    await expect(block(page, blockId).locator(".execution-eligibility"))
      .toHaveAttribute("data-eligibility", "eligible");
  }
  await expect(page.locator(".execution-eligibility[data-eligibility='eligible']")).toHaveCount(4);
  await expect(block(page, "B001").locator(".execution-eligibility"))
    .toContainText("不构成外部执行授权");

  await block(page, "B001").locator("button[data-action='EDIT']").click();
  await page.locator("dialog textarea").fill("Change the root dependency.");
  await page.locator("dialog").getByRole("button", { name: "保存" }).click();
  for (const blockId of ["B001", "B002", "B003"]) {
    await expect(block(page, blockId).locator(".execution-eligibility"))
      .toHaveAttribute("data-eligibility", "suspended");
  }
  await expect(block(page, "B004").locator(".execution-eligibility"))
    .toHaveAttribute("data-eligibility", "eligible");

  await block(page, "B001").locator("button[data-action='HOLD']").click();
  await page.locator("dialog textarea").fill("Answer the root question.");
  await page.locator("dialog").getByRole("button", { name: "保存" }).click();
  await expect(block(page, "B003").locator(".execution-eligibility"))
    .toHaveAttribute("data-eligibility", "suspended");

  await block(page, "B001").locator("button[data-action='TOPIC']").click();
  await page.locator("dialog input[data-field='title']").fill("Separate root topic");
  await page.locator("dialog").getByRole("button", { name: "保存" }).click();
  const rootTopic = page.locator(".topic-list li").filter({ hasText: "Separate root topic" });
  await expect(rootTopic).toContainText("TOP-001");
  await expect(rootTopic).toContainText("B001");
  await expect(block(page, "B002").locator(".execution-eligibility"))
    .toHaveAttribute("data-eligibility", "suspended");

  await block(page, "B001").getByRole("button", { name: "撤销决定" }).click();
  await expect(block(page, "B001").locator(".st-chip")).toContainText("待处理");
  await expect(page.locator(".topic-list")).not.toContainText("Separate root topic");
  await expect(block(page, "B003").locator(".execution-eligibility"))
    .toHaveAttribute("data-eligibility", "suspended");
});

test("@A16 frozen blocks expose eligibility without exposing review actions", async ({ page }) => {
  await openWorkbench(page, frozenWorkbenchUrl, 3);
  await expect(block(page, "B004").locator(".execution-eligibility"))
    .toHaveAttribute("data-eligibility", "eligible");
  await expect(block(page, "B004").locator("button.act[data-action]")).toHaveCount(0);
  await expect(block(page, "B003").locator(".execution-eligibility"))
    .toHaveAttribute("data-eligibility", "suspended");
});

test("@A20 keyboard actions, focus trap, overwrite, undo, search, and topic pairing", async ({ page }) => {
  await openWorkbench(page);
  await expect(block(page, "B001").locator("details.b-body")).toHaveAttribute("open", "");
  await expect(block(page, "B002").locator("details.b-body")).not.toHaveAttribute("open", "");
  await expect(block(page, "B003").locator("details.b-body")).not.toHaveAttribute("open", "");

  await page.keyboard.press("j");
  await expect(block(page, "B002")).toBeFocused();
  await page.keyboard.press("1");
  await expect(block(page, "B002").locator(".st-chip")).toContainText("通过");
  await expect(block(page, "B003")).toBeFocused();

  await page.keyboard.press("2");
  const dialog = page.locator("dialog[open]");
  const editor = dialog.locator("textarea");
  await expect(editor).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(editor).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(block(page, "B003").locator("button[data-action='EDIT']")).toBeFocused();
  await expect(block(page, "B003").locator(".st-chip")).toContainText("待处理");

  await page.keyboard.press("2");
  await editor.fill("Need deterministic output.");
  await page.keyboard.press("Control+Enter");
  await expect(block(page, "B003").locator(".st-chip")).toContainText("修改");
  await expect(block(page, "B004")).toBeFocused();

  await page.keyboard.press("3");
  const topicTitle = dialog.locator("input[data-field='title']");
  await expect(topicTitle).toBeFocused();
  await topicTitle.fill("Derived migration plan");
  await page.keyboard.press("Tab");
  await dialog.locator("textarea[data-field='note']").fill("Keep it independent.");
  await page.keyboard.press("Control+Enter");
  await expect(block(page, "B004").locator(".st-chip")).toContainText("新主题");
  const derivedTopic = page.locator(".topic-list li").filter({ hasText: "Derived migration plan" });
  await expect(derivedTopic).toContainText("TOP-001");
  await expect(derivedTopic).toContainText("B004");
  await expect(block(page, "B001")).toBeFocused();

  await page.keyboard.press("4");
  await dialog.locator("textarea[data-field='note']").fill("Which approval boundary applies?");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".p-num")).toContainText("4 共 4");
  await expect(block(page, "B001").locator(".st-chip")).toContainText("存疑");

  await page.keyboard.press("1");
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");
  await page.keyboard.press("2");
  await page.keyboard.press("Escape");
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");

  const b1Decision = page.locator(".decision-list li").filter({ hasText: "B001" });
  const undo = b1Decision.getByRole("button", { name: "撤销决定" });
  await undo.focus();
  await page.keyboard.press("Enter");
  await expect(block(page, "B001").locator(".st-chip")).toContainText("待处理");
  await expect(page.locator(".p-num")).toContainText("3 共 4");

  const search = page.locator("#decision-search");
  await search.focus();
  await search.fill("deterministic");
  await expect(block(page, "B003")).toBeVisible();
  await expect(block(page, "B002")).toBeHidden();
  await page.keyboard.press("1");
  await expect(block(page, "B003").locator(".st-chip")).toContainText("修改");
  await search.fill("");
  await page.locator("#review-filter button[data-filter='annotated']").click();
  await expect(block(page, "B001")).toBeHidden();
  await expect(block(page, "B002")).toBeVisible();

  const sourceTopic = page.locator(".topic-list li").filter({ hasText: "Derived migration plan" });
  const deleteTopic = sourceTopic.getByRole("button", { name: "删除" });
  await deleteTopic.focus();
  await page.keyboard.press("Enter");
  await page.locator("#review-filter button[data-filter='all']").click();
  await expect(block(page, "B004").locator(".st-chip")).toContainText("待处理");
  await expect(page.locator(".topic-list")).not.toContainText("Derived migration plan");
});

test("@A20 current-block quoting preserves full text and rejects cross-block selections", async ({ page }) => {
  await openWorkbench(page);
  const selected = await block(page, "B001").locator("p.b-tldr").textContent();
  await page.evaluate(() => {
    const text = document.querySelector("#block-B001 p.b-tldr")?.firstChild;
    if (text === null || text === undefined) throw new Error("selection fixture missing");
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press("2");
  await page.locator("dialog textarea").fill("Quote this exact summary.");
  await page.keyboard.press("Control+Enter");
  await block(page, "B001").locator("details.decision-quote summary").click();
  await expect(block(page, "B001").locator("details.decision-quote blockquote"))
    .toHaveText(selected ?? "");

  await page.reload();
  await page.evaluate(() => {
    const start = document.querySelector("#block-B001 p.b-tldr")?.firstChild;
    const end = document.querySelector("#block-B002 p.b-tldr")?.firstChild;
    if (start === null || start === undefined || end === null || end === undefined) {
      throw new Error("selection fixture missing");
    }
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.textContent?.length ?? 0);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press("1");
  await expect(block(page, "B001").locator("details.decision-quote")).toHaveCount(0);
});

test("@A20 pointer action bounds and keyboard annotation management remain observable", async ({ page }) => {
  await openWorkbench(page);
  await block(page, "B001").locator("button[data-action='PASS']").click();
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");
  await block(page, "B002").locator("button[data-action='EDIT']").click();
  await page.locator("dialog textarea").fill("Two-click modification.");
  await page.locator("dialog").getByRole("button", { name: "保存" }).click();
  await expect(block(page, "B002").locator(".st-chip")).toContainText("修改");

  await page.keyboard.press("j");
  const noteInput = page.locator("#side-note-input");
  await openRailEditor(page, "side-note-input");
  await noteInput.focus();
  await noteInput.fill("Keep this thought separate.");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".side-note-list")).toContainText("NOTE-001");

  const topicTitle = page.locator("#global-topic-title");
  await openRailEditor(page, "global-topic-title");
  await topicTitle.focus();
  await topicTitle.fill("Global follow-up");
  await page.keyboard.press("Control+Enter");
  const globalTopic = page.locator(".topic-list li").filter({ hasText: "Global follow-up" });
  await expect(globalTopic).toContainText("TOP-001");
  await expect(globalTopic).toContainText("全局主题");

  const overall = page.locator("#overall-review");
  await openRailEditor(page, "overall-review");
  await overall.focus();
  await overall.fill("Overall direction is sound.");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#workbench-status")).toHaveText("保存");
});

test("@A20 action surface has no serious axe violations in blocking browsers", async ({ page, browserName }) => {
  test.skip(browserName === "firefox", "Firefox remains the Design §14 smoke lane");
  await openWorkbench(page);
  await page.keyboard.press("2");
  const dialogResults = await new AxeBuilder({ page }).include("dialog").analyze();
  expect(dialogResults.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
  await page.keyboard.press("Escape");
  const pageResults = await new AxeBuilder({ page }).analyze();
  expect(pageResults.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
});

test("@A20 a note edit stays bound to its own block when the review cursor moves", async ({ page }) => {
  await openWorkbench(page);

  // Record a note on the first block.
  const noteInput = page.locator("#side-note-input");
  await openRailEditor(page, "side-note-input");
  await noteInput.focus();
  await noteInput.fill("Original thought about the first block.");
  await page.keyboard.press("Control+Enter");
  const noteList = page.locator(".side-note-list");
  const noteRow = noteList.locator("li").filter({ hasText: "NOTE-001" });
  await expect(noteRow).toContainText("B001");

  // Reopen it for editing, then re-read another block before saving. Clicking a
  // block moves the review cursor, which is ordinary use, not a corner case.
  await noteList.getByRole("button", { name: "编辑" }).click();
  await expect(noteInput).toHaveValue("Original thought about the first block.");
  await block(page, "B003").click();
  await expect(page.locator(".rail-current")).toContainText("B003");

  await openRailEditor(page, "side-note-input");
  await noteInput.focus();
  await noteInput.fill("Revised thought, still about the first block.");
  await page.keyboard.press("Control+Enter");

  // The edit must land on the note's own block, not on whatever is focused.
  await expect(noteRow).toContainText("B001");
  await expect(noteRow).toContainText("Revised thought, still about the first block.");
  await expect(noteList).not.toContainText("NOTE-002");
  await expect(page.locator("#workbench-status")).toHaveText("保存");
});

test("@A20 a rejected action reports an understandable hint instead of a machine code", async ({ page }) => {
  await openWorkbench(page);

  // An empty note is rejected by the reducer with NOTE_REQUIRED.
  const noteInput = page.locator("#side-note-input");
  await openRailEditor(page, "side-note-input");
  await noteInput.focus();
  await noteInput.fill("   ");
  await page.keyboard.press("Control+Enter");

  const status = page.locator("#workbench-status");
  await expect(status).toHaveText("未保存: 随手记内容不能为空");
  await expect(status).not.toContainText("NOTE_REQUIRED");
  await expect(page.locator(".side-note-list")).toContainText("尚未记录随手记");
});
