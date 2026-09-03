import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  blockContentDigest,
  canonicalJson,
  computeReviewDigest,
  parseReviewPacketMarkdown,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";
import { buildReviewPacket } from "../../src/workbench/packet.js";
import { buildReviewState } from "../../src/workbench/state.js";
import { createInitialReviewState, reduceReviewState } from "../../src/workbench/reducer.js";

// Option A keeps the rail compact: each editor sits in a closed disclosure, so a
// reviewer opens it exactly as they would in the approved prototype.
async function openRailEditor(page: Page, controlId: string): Promise<void> {
  const fold = page.locator(`details.rail-fold:has(#${controlId})`);
  if (!(await fold.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await fold.locator("summary").click();
  }
}

let fixtureDirectory = "";
let workbenchUrl = "";
let frozenWorkbenchUrl = "";
let importedStateJson = "";
let importedPacketJson = "";
let badStateJson = "";
let legacyStateJson = "";
let reopenedStateJson = "";
let emptyOverlayStateJson = "";
let documentValue: ReviewDocumentV1;

function fillTemplate(template: string, value: ReviewDocumentV1): string {
  const digest = computeReviewDigest(value);
  if (!digest.ok) throw new Error("review digest failed");
  const replacements: Readonly<Record<string, string>> = {
    "@@DAR_GENERATOR_VERSION@@": "0.2.1",
    "@@DAR_DOCUMENT_ID@@": value.document.id,
    "@@DAR_CONTENT_VERSION@@": String(value.document.contentVersion),
    "@@DAR_ROUND@@": String(value.document.round),
    "@@DAR_REVIEW_DIGEST@@": digest.value,
    "@@DAR_DOCUMENT_BASE64@@": Buffer.from(canonicalJson(value), "utf8").toString("base64"),
  };
  let html = template;
  for (const [token, replacement] of Object.entries(replacements)) {
    if (html.split(token).length !== 2) throw new Error(`bad generator token: ${token}`);
    html = html.replace(token, () => replacement);
  }
  if (html.includes("@@DAR_")) throw new Error("unresolved generator token");
  return html;
}

function apply(
  value: ReviewDocumentV1,
  state: ReturnType<typeof createInitialReviewState>,
  action: Parameters<typeof reduceReviewState>[2],
) {
  const result = reduceReviewState(value, state, action);
  if (!result.ok) throw new Error(result.code);
  return result.state;
}

test.beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "dar-workbench-ui-003-"));
  const [template, rawDocument] = await Promise.all([
    readFile(resolve("skills/deliver-dual-audience-report/assets/review-workbench.template.html"), "utf8"),
    readFile(resolve("tests/fixtures/protocol/review-document.json"), "utf8").then(JSON.parse),
  ]);
  documentValue = rawDocument as ReviewDocumentV1;
  documentValue.document.uiLocale = "zh-CN";
  const normalPath = join(fixtureDirectory, "recovery.html");
  await writeFile(normalPath, fillTemplate(template, documentValue), "utf8");
  workbenchUrl = pathToFileURL(normalPath).href;

  const frozen = structuredClone(documentValue);
  const frozenBlock = frozen.blocks.find((block) => block.id === "B004");
  if (frozenBlock === undefined) throw new Error("frozen fixture block missing");
  frozen.approvals.history = [{
    blockId: "B004",
    approvedRound: frozen.document.round,
    approvedContentDigest: blockContentDigest(frozenBlock),
  }];
  frozen.approvals.currentFrozen = ["B004"];
  const frozenPath = join(fixtureDirectory, "recovery-frozen.html");
  await writeFile(frozenPath, fillTemplate(template, frozen), "utf8");
  frozenWorkbenchUrl = pathToFileURL(frozenPath).href;
  const reopened = apply(frozen, createInitialReviewState(frozen), {
    type: "REOPEN_BLOCK",
    blockId: "B004",
  });
  const reopenedState = buildReviewState(frozen, reopened, "2026-08-13T00:30:00.000Z");
  if (!reopenedState.ok) throw new Error(reopenedState.errors.map((error) => error.code).join(","));
  reopenedStateJson = JSON.stringify(reopenedState.value);

  let imported = createInitialReviewState(documentValue);
  imported = apply(documentValue, imported, {
    type: "SET_DECISION",
    blockId: "B002",
    decision: { action: "EDIT", note: "Imported exact state." },
  });
  const state = buildReviewState(documentValue, imported, "2026-08-13T01:00:00.000Z");
  if (!state.ok) throw new Error(state.errors.map((error) => error.code).join(","));
  importedStateJson = JSON.stringify(state.value);
  const packet = buildReviewPacket(documentValue, imported, "2026-08-13T01:00:00.000Z");
  if (!packet.ok) throw new Error(packet.errors.map((error) => error.code).join(","));
  importedPacketJson = JSON.stringify(packet.value);
  const bad = structuredClone(state.value);
  bad.doc.round += 1;
  badStateJson = JSON.stringify(bad);
  const legacy = structuredClone(state.value) as unknown as Record<string, unknown>;
  delete legacy.format;
  delete (legacy.doc as Record<string, unknown>).contentVersion;
  (legacy.decisions as Array<Record<string, unknown>>)[0]!.action = "TRIM";
  legacyStateJson = JSON.stringify(legacy);

  let emptyOverlay = createInitialReviewState(documentValue);
  emptyOverlay = apply(documentValue, emptyOverlay, {
    type: "SET_SIDE_NOTE",
    blockId: "B001",
    note: "Allocate note high-water.",
  });
  emptyOverlay = apply(documentValue, emptyOverlay, {
    type: "DELETE_SIDE_NOTE",
    noteId: "NOTE-001",
  });
  emptyOverlay = apply(documentValue, emptyOverlay, {
    type: "ADD_TOPIC",
    title: "Allocate topic high-water.",
  });
  emptyOverlay = apply(documentValue, emptyOverlay, {
    type: "DELETE_TOPIC",
    topicId: "TOP-001",
  });
  const emptyOverlayState = buildReviewState(
    documentValue,
    emptyOverlay,
    "2026-08-13T01:02:00.000Z",
  );
  if (!emptyOverlayState.ok) throw new Error("empty overlay state failed");
  emptyOverlayStateJson = JSON.stringify(emptyOverlayState.value);
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
  await expect(page.locator("meta[name^='dar-']")).toHaveCount(6);
  await expect(page.locator("meta[name='dar-artifact'][content='review-approval-html/1']")).toHaveCount(1);
  for (const name of [
    "dar-generator-version",
    "dar-document-id",
    "dar-content-version",
    "dar-round",
    "dar-review-digest",
  ]) {
    await expect(page.locator(`meta[name='${name}']`)).toHaveCount(1);
  }
  await expect(page.locator("article.blk")).toHaveCount(4);
  await expect(page.locator(".p-num")).toContainText(`0 共 ${total}`);
}

function block(page: Page, blockId: string) {
  return page.locator(`article#block-${blockId}`);
}

function persistenceDialog(page: Page) {
  return page.locator("dialog.persistence-dialog[open]");
}

test("@A02 partial packet JSON and Markdown share one exact cached machine payload", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (globalThis as typeof globalThis & { __copied?: string }).__copied = text;
        },
      },
    });
  });
  await openWorkbench(page);
  await block(page, "B001").locator("button[data-action='EDIT']").click();
  const reviewDialog = page.locator("dialog.review-dialog[open]");
  await reviewDialog.locator("textarea[data-field='note']").fill("Partial decision with ```` and </script> 😀");
  await reviewDialog.getByRole("button", { name: "保存" }).click();
  await page.getByRole("button", { name: "复制回执 Markdown" }).click();
  const dialog = persistenceDialog(page);
  await dialog.getByRole("button", { name: "复制", exact: true }).click();
  await expect(dialog.locator(".export-result")).toContainText("已明确确认");
  const markdown = await page.evaluate(() => (
    (globalThis as typeof globalThis & { __copied?: string }).__copied ?? ""
  ));
  const parsed = parseReviewPacketMarkdown(markdown, documentValue);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.progress).toEqual({ decided: 1, total: 4, partial: true });
    expect(parsed.value.decisions[0]).toMatchObject({ blockId: "B001", action: "EDIT" });
  }
  await dialog.getByRole("button", { name: "关闭" }).click();
  await page.getByRole("button", { name: "导出回执 JSON" }).click();
  const json = JSON.parse(await persistenceDialog(page).locator("textarea.export-content").inputValue()) as {
    reviewedAt: string;
    semanticDigest: string;
  };
  if (parsed.ok) {
    expect(json.reviewedAt).toBe(parsed.value.reviewedAt);
    expect(json.semanticDigest).toBe(parsed.value.semanticDigest);
  }
});

test("@A08/@A17 reopening creates active controls and exports an unambiguous reopened PASS", async ({ page }) => {
  await openWorkbench(page, frozenWorkbenchUrl, 3);
  await expect(block(page, "B004").getByRole("button", { name: "重新打开冻结块" })).toHaveCount(1);
  await block(page, "B004").getByRole("button", { name: "重新打开冻结块" }).click();
  await expect(page.locator(".p-num")).toContainText("0 共 4");
  await expect(block(page, "B004").locator(".reopen-status")).toContainText("历史批准保留");
  await expect(block(page, "B004").locator("button.act[data-action]")).toHaveCount(4);
  await block(page, "B004").locator("button[data-action='PASS']").click();
  await expect(block(page, "B004").locator(".st-chip")).toContainText("通过");
  await page.getByRole("button", { name: "导出回执 JSON" }).click();
  const packet = JSON.parse(await persistenceDialog(page).locator("textarea.export-content").inputValue()) as {
    reopened: string[];
    frozenCarried: string[];
    decisions: Array<{ blockId: string; action: string }>;
  };
  expect(packet.reopened).toEqual(["B004"]);
  expect(packet.frozenCarried).toEqual([]);
  expect(packet.decisions).toContainEqual({ blockId: "B004", action: "PASS" });
});

test("recovers a decision after immediate reload and reports savedAt plus count", async ({ page }) => {
  await openWorkbench(page);
  await block(page, "B001").locator("button[data-action='PASS']").click();
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");
  await page.reload();
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");
  await expect(page.locator(".persistence-status")).toContainText("已恢复保存的审阅");
  await expect(page.locator(".persistence-status")).toContainText("记录数: 1");
});

test("@A10/@A22 storage degradation stays visible; explicit export quiets it only until the next change", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
    Storage.prototype.setItem = () => { throw new Error("blocked"); };
    Storage.prototype.removeItem = () => { throw new Error("blocked"); };
  });
  await openWorkbench(page);
  await expect(page.locator(".persistence-status")).toContainText("自动保存不可用");
  await block(page, "B001").locator("button[data-action='PASS']").click();
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");
  await page.getByRole("button", { name: "导出审阅状态" }).click();
  const dialog = persistenceDialog(page);
  await dialog.getByRole("button", { name: "手动复制" }).click();
  await dialog.getByRole("button", { name: "我已保存或复制此快照" }).click();
  await expect(page.locator(".persistence-status")).toContainText("当前状态已手动导出");
  await dialog.getByRole("button", { name: "关闭" }).click();
  await block(page, "B001").locator("button[data-action='HOLD']").click();
  const reviewDialog = page.locator("dialog.review-dialog[open]");
  await reviewDialog.locator("textarea[data-field='note']").fill("Changed after export.");
  await reviewDialog.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".persistence-status")).toContainText("离开前请导出状态");
});

test("@A10/@A22 rejected recovery remains visible beside unsaved and manual-export status", async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string, value: string): void {
      const shouldFail = (globalThis as typeof globalThis & { __failUi3Save?: boolean })
        .__failUi3Save === true;
      if (shouldFail && key.startsWith("review-workbench/1:")) throw new Error("blocked");
      originalSetItem.call(this, key, value);
    };
  });
  await openWorkbench(page);
  const storageKey = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => (
      candidate.startsWith("review-workbench/1:")
      && candidate !== "review-workbench/1:capability-probe"
    ));
    if (key === undefined) throw new Error("review storage key missing");
    localStorage.setItem(key, '{"format":"review-packet/1"}');
    return key;
  });
  await page.reload();
  const status = page.locator(".persistence-status");
  await expect(status).toContainText("已保存的恢复数据被拒绝");

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __failUi3Save?: boolean }).__failUi3Save = true;
  });
  await block(page, "B001").locator("button[data-action='PASS']").click();
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");
  await expect(status).toContainText("已保存的恢复数据被拒绝");
  await expect(status).toContainText("离开前请导出状态");

  await page.getByRole("button", { name: "导出审阅状态" }).click();
  const dialog = persistenceDialog(page);
  await dialog.getByRole("button", { name: "手动复制" }).click();
  await dialog.getByRole("button", { name: "我已保存或复制此快照" }).click();
  await expect(status).toContainText("已保存的恢复数据被拒绝");
  await expect(status).toContainText("当前状态已手动导出");
  await dialog.getByRole("button", { name: "关闭" }).click();

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __failUi3Save?: boolean }).__failUi3Save = false;
  });
  await block(page, "B002").locator("button[data-action='PASS']").click();
  await expect(block(page, "B002").locator(".st-chip")).toContainText("通过");
  await expect(status).toContainText("本地自动保存可用");
  await expect(status).not.toContainText("已保存的恢复数据被拒绝");
  await expect.poll(async () => page.evaluate((key) => {
    const stored = localStorage.getItem(key);
    return stored === null ? "" : (JSON.parse(stored) as { format?: string }).format ?? "";
  }, storageKey)).toBe("review-state/1");
});

test("@A11 clipboard rejection retains complete text and never reports success before manual confirmation", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => Promise.reject(new Error("denied")) },
    });
  });
  await openWorkbench(page);
  await page.getByRole("button", { name: "复制回执 Markdown" }).click();
  const dialog = persistenceDialog(page);
  const content = await dialog.locator("textarea.export-content").inputValue();
  await dialog.getByRole("button", { name: "复制", exact: true }).click();
  await expect(dialog.locator(".export-result")).toContainText("剪贴板写入失败");
  await expect(dialog.locator("textarea.export-content")).toHaveValue(content);
  await expect(dialog.getByRole("button", { name: "我已保存或复制此快照" })).toBeVisible();
  await expect(dialog.locator(".export-result")).not.toContainText("已明确确认");
});

test("@A11 Escape closes the full-text fallback dialog and restores the invoking control", async ({ page }) => {
  await openWorkbench(page);
  const opener = page.getByRole("button", { name: "复制回执 Markdown" });
  await opener.click();
  await expect(persistenceDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(persistenceDialog(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("@A22 a pending clipboard success cannot confirm a snapshot after state changes", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
    Storage.prototype.setItem = () => { throw new Error("blocked"); };
    Storage.prototype.removeItem = () => { throw new Error("blocked"); };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (_text: string) => new Promise<void>((resolveCopy) => {
          (globalThis as typeof globalThis & { __resolveCopy?: () => void }).__resolveCopy = resolveCopy;
        }),
      },
    });
  });
  await openWorkbench(page);
  await page.getByRole("button", { name: "导出审阅状态" }).click();
  const dialog = persistenceDialog(page);
  await dialog.getByRole("button", { name: "复制", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await block(page, "B001").locator("button[data-action='PASS']").click();
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __resolveCopy?: () => void }).__resolveCopy?.();
  });
  await expect(page.locator(".persistence-status")).toContainText("离开前请导出状态");
  await expect(page.locator(".persistence-status")).not.toContainText("当前状态已手动导出");
});

test("@A10/@A22 download triggering is not success until the digest-stable explicit confirmation", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
    Storage.prototype.setItem = () => { throw new Error("blocked"); };
    Storage.prototype.removeItem = () => { throw new Error("blocked"); };
  });
  await openWorkbench(page);
  await block(page, "B001").locator("button[data-action='PASS']").click();
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");
  await page.getByRole("button", { name: "导出审阅状态" }).click();
  const dialog = persistenceDialog(page);
  await dialog.getByRole("button", { name: "下载", exact: true }).click();
  await expect(dialog.locator(".export-result")).toContainText("请仅在文件实际保存后确认");
  await expect(page.locator(".persistence-status")).toContainText("离开前请导出状态");
  const confirm = dialog.getByRole("button", { name: /我已保存或复制此快照.*记录数: 1/u });
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect(page.locator(".persistence-status")).toContainText("当前状态已手动导出");
});

test("@A18 exact import is atomic; missing-format migration requires visible identity confirmation", async ({ page }) => {
  await openWorkbench(page);
  await block(page, "B001").locator("button[data-action='PASS']").click();
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");
  await page.getByRole("button", { name: "导入状态或回执" }).click();
  let dialog = persistenceDialog(page);
  await dialog.locator("textarea").fill(badStateJson);
  await dialog.getByRole("button", { name: "验证并导入" }).click();
  await expect(dialog.locator(".import-error")).toContainText("导入已拒绝");
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");
  await dialog.getByRole("button", { name: "取消" }).click();

  await page.getByRole("button", { name: "导入状态或回执" }).click();
  dialog = persistenceDialog(page);
  await dialog.locator("textarea").fill(importedStateJson);
  await dialog.getByRole("button", { name: "验证并导入" }).click();
  await expect(block(page, "B001").locator(".st-chip")).toContainText("待处理");
  await expect(block(page, "B002").locator(".st-chip")).toContainText("修改");

  await page.getByRole("button", { name: "导入状态或回执" }).click();
  dialog = persistenceDialog(page);
  await dialog.locator("textarea").fill(legacyStateJson);
  await dialog.getByRole("button", { name: "验证并导入" }).click();
  await expect(dialog.locator(".import-error")).toContainText("导入已拒绝");
  await dialog.locator("#legacy-identity-confirmation").check();
  await dialog.getByRole("button", { name: "验证并导入" }).click();
  await expect(block(page, "B002").locator(".st-chip")).toContainText("【精简】Imported exact state.");
});

test("@A18 explicit import accepts an exact packet but automatic restore never treats it as state", async ({ page }) => {
  await openWorkbench(page);
  await page.getByRole("button", { name: "导入状态或回执" }).click();
  let dialog = persistenceDialog(page);
  await dialog.locator("textarea").fill(importedPacketJson);
  await dialog.getByRole("button", { name: "验证并导入" }).click();
  await expect(block(page, "B002").locator(".st-chip")).toContainText("修改");

  await page.getByRole("button", { name: "导出回执 JSON" }).click();
  dialog = persistenceDialog(page);
  const canonicalPacket = await dialog.locator("textarea.export-content").inputValue();
  await dialog.getByRole("button", { name: "关闭" }).click();
  const key = await page.evaluate(() => Object.keys(localStorage)
    .find((item) => item.startsWith("review-workbench/1:")));
  expect(key).toBeDefined();
  await page.evaluate(({ storageKey, packet }) => {
    localStorage.setItem(storageKey, packet);
  }, { storageKey: key!, packet: canonicalPacket });
  await page.reload();
  await expect(page.locator(".persistence-status")).toContainText("恢复数据被拒绝");
  await expect(block(page, "B002").locator(".st-chip")).toContainText("待处理");
});

test("@A18 import rejects current-memory high-water regression and preserves allocation", async ({ page }) => {
  await openWorkbench(page);
  await openRailEditor(page, "global-topic-title");
  await page.locator("#global-topic-title").fill("Allocated then deleted");
  await page.getByRole("button", { name: "添加全局主题" }).click();
  await expect(page.locator(".topic-list")).toContainText("TOP-001");
  await page.locator(".topic-list").getByRole("button", { name: "删除" }).click();
  await page.getByRole("button", { name: "导入状态或回执" }).click();
  const dialog = persistenceDialog(page);
  await dialog.locator("textarea").fill(importedStateJson);
  await dialog.getByRole("button", { name: "验证并导入" }).click();
  await expect(dialog.locator(".import-error")).toContainText("HIGH_WATER_REGRESSION /idHighWater/topic");
  await dialog.getByRole("button", { name: "取消" }).click();
  await openRailEditor(page, "global-topic-title");
  await page.locator("#global-topic-title").fill("Allocated after rejection");
  await page.getByRole("button", { name: "添加全局主题" }).click();
  await expect(page.locator(".topic-list")).toContainText("TOP-002");
});

test("@A08 imported reopened state rebuilds controls after clear without duplicates", async ({ page }) => {
  await openWorkbench(page, frozenWorkbenchUrl, 3);
  const importReopened = async (): Promise<void> => {
    await page.getByRole("button", { name: "导入状态或回执" }).click();
    const dialog = persistenceDialog(page);
    await dialog.locator("textarea").fill(reopenedStateJson);
    await dialog.getByRole("button", { name: "验证并导入" }).click();
  };
  await importReopened();
  await expect(page.locator(".p-num")).toContainText("0 共 4");
  await expect(block(page, "B004").locator("button.act[data-action]:visible")).toHaveCount(4);
  await page.getByRole("button", { name: "清空审阅" }).click();
  await persistenceDialog(page).getByRole("button", { name: "清空并重新开始" }).click();
  await expect(page.locator(".p-num")).toContainText("0 共 3");
  await expect(block(page, "B004").locator("button.act[data-action]:visible")).toHaveCount(0);
  await expect(block(page, "B004").getByRole("button", { name: "重新打开冻结块" })).toBeVisible();
  await block(page, "B004").focus();
  await page.keyboard.press("2");
  await expect(page.locator("dialog.review-dialog[open]")).toHaveCount(0);
  await importReopened();
  await expect(block(page, "B004").locator("button.act[data-action]:visible")).toHaveCount(4);
  await expect(block(page, "B004").locator("button.act[data-action]")).toHaveCount(4);
});

test("successful import resets note and topic editors for records removed by the snapshot", async ({ page }) => {
  await openWorkbench(page);
  await openRailEditor(page, "side-note-input");
  await page.locator("#side-note-input").fill("Stale note editor");
  await page.getByRole("button", { name: "添加随手记" }).click();
  await openRailEditor(page, "global-topic-title");
  await page.locator("#global-topic-title").fill("Stale topic editor");
  await page.getByRole("button", { name: "添加全局主题" }).click();
  await page.locator(".side-note-list").getByRole("button", { name: "编辑" }).click();
  await page.locator(".topic-list").getByRole("button", { name: "编辑" }).click();
  await expect(page.locator("#side-note-input")).toHaveValue("Stale note editor");
  await expect(page.locator("#global-topic-title")).toHaveValue("Stale topic editor");

  await page.getByRole("button", { name: "导入状态或回执" }).click();
  const dialog = persistenceDialog(page);
  await dialog.locator("textarea").fill(emptyOverlayStateJson);
  await dialog.getByRole("button", { name: "验证并导入" }).click();
  await expect(page.locator("#side-note-input")).toHaveValue("");
  await expect(page.locator("#global-topic-title")).toHaveValue("");
  await expect(page.locator("#global-topic-note")).toHaveValue("");

  await openRailEditor(page, "side-note-input");

  await page.locator("#side-note-input").fill("Fresh note after import");
  await page.locator("#side-note-input").press("Control+Enter");
  await expect(page.locator(".side-note-list")).toContainText("NOTE-002");
  await openRailEditor(page, "global-topic-title");
  await page.locator("#global-topic-title").fill("Fresh topic after import");
  await page.locator("#global-topic-title").press("Control+Enter");
  await expect(page.locator(".topic-list")).toContainText("TOP-002");
});

test("clear save failure leaves memory intact and successful clear preserves allocated IDs", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string, value: string): void {
      if ((globalThis as typeof globalThis & { __failSave?: boolean }).__failSave === true) {
        throw new Error("forced");
      }
      original.call(this, key, value);
    };
  });
  await openWorkbench(page);
  await openRailEditor(page, "global-topic-title");
  await page.locator("#global-topic-title").fill("Allocated topic");
  await page.getByRole("button", { name: "添加全局主题" }).click();
  await expect(page.locator(".topic-list")).toContainText("TOP-001");
  await page.evaluate(() => { (globalThis as typeof globalThis & { __failSave?: boolean }).__failSave = true; });
  await page.getByRole("button", { name: "清空审阅" }).click();
  let dialog = persistenceDialog(page);
  await dialog.getByRole("button", { name: "清空并重新开始" }).click();
  await expect(dialog.locator(".dialog-error")).toContainText("状态替换未提交");
  await expect(page.locator(".topic-list")).toContainText("TOP-001");
  await dialog.getByRole("button", { name: "取消" }).click();
  await page.evaluate(() => { (globalThis as typeof globalThis & { __failSave?: boolean }).__failSave = false; });
  await block(page, "B001").locator("button[data-action='PASS']").click();
  await expect(block(page, "B001").locator(".st-chip")).toContainText("通过");
  await page.getByRole("button", { name: "清空审阅" }).click();
  dialog = persistenceDialog(page);
  await dialog.getByRole("button", { name: "清空并重新开始" }).click();
  await expect(page.locator(".topic-list")).not.toContainText("TOP-001");
  await openRailEditor(page, "global-topic-title");
  await page.locator("#global-topic-title").fill("New topic after clear");
  await page.getByRole("button", { name: "添加全局主题" }).click();
  await expect(page.locator(".topic-list")).toContainText("TOP-002");
});
