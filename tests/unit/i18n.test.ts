import { describe, expect, it } from "vitest";
import {
  SUPPORTED_UI_LOCALES,
  assertCompleteLocaleTables,
  isUiLocale,
  reducerErrorMessage,
  stringsFor,
} from "../../src/workbench/i18n.js";
import type { ReviewReducerErrorCode } from "../../src/workbench/reducer.js";

const REDUCER_ERROR_CODES: readonly ReviewReducerErrorCode[] = [
  "BLOCK_NOT_FOUND",
  "BLOCK_FROZEN",
  "BLOCK_NOT_FROZEN",
  "BLOCK_ALREADY_REOPENED",
  "DECISION_REQUIRED",
  "DECISION_NOTE_REQUIRED",
  "TOPIC_TITLE_REQUIRED",
  "TOPIC_ID_INVALID",
  "TOPIC_ID_COLLISION",
  "TOPIC_PAIR_INVALID",
  "NOTE_REQUIRED",
  "NOTE_ID_INVALID",
  "NOTE_NOT_FOUND",
  "TOPIC_NOT_FOUND",
  "ID_HIGH_WATER_EXHAUSTED",
  "BULK_SELECTION_INVALID",
];

describe("workbench locale tables", () => {
  it("keeps zh-CN and en complete with the same closed key set", () => {
    expect(() => assertCompleteLocaleTables()).not.toThrow();
    expect(SUPPORTED_UI_LOCALES).toEqual(["zh-CN", "en"]);
    expect(Object.keys(stringsFor("zh-CN")).sort()).toEqual(Object.keys(stringsFor("en")).sort());
    expect(stringsFor("zh-CN").skipToMain).toBe("跳到决策块");
    expect(stringsFor("en").skipToMain).toBe("Skip to decision blocks");
    expect(stringsFor("zh-CN").glossaryJump).toBe("跳到术语表");
    expect(stringsFor("en").glossaryJump).toBe("Go to glossary");
  });

  it("does not silently fall back for an unknown locale", () => {
    expect(isUiLocale("zh-CN")).toBe(true);
    expect(isUiLocale("en")).toBe(true);
    expect(isUiLocale("en-US")).toBe(false);
    expect(isUiLocale("fr")).toBe(false);
  });
});

describe("rejected review actions report understandable hints", () => {
  it("maps every reducer error code to a localized message that never leaks the code", () => {
    for (const locale of SUPPORTED_UI_LOCALES) {
      const strings = stringsFor(locale);
      const seen = new Set<string>();
      for (const code of REDUCER_ERROR_CODES) {
        const message = reducerErrorMessage(code, strings);
        expect(message.length).toBeGreaterThan(strings.errorNotSaved.length + 2);
        expect(message.startsWith(`${strings.errorNotSaved}: `)).toBe(true);
        // The raw machine code must never reach the live region.
        expect(message).not.toContain(code);
        expect(message).not.toMatch(/[A-Z]{3,}_[A-Z]/u);
        seen.add(message);
      }
      // Distinct causes must stay distinguishable, not collapse into one hint.
      expect(seen.size).toBe(REDUCER_ERROR_CODES.length);
    }
  });

  it("states what happened and what the reviewer can do next", () => {
    const en = stringsFor("en");
    expect(reducerErrorMessage("BLOCK_FROZEN", en)).toBe("Not saved: this block is frozen. Reopen it before deciding");
    expect(reducerErrorMessage("NOTE_ID_INVALID", en)).toContain("Reopen it from the note list");

    const zh = stringsFor("zh-CN");
    expect(reducerErrorMessage("DECISION_NOTE_REQUIRED", zh)).toBe("未保存: 该动作必须填写可执行的意见或需要先回答的问题");
  });

  it("degrades an unknown or hostile code to a neutral hint instead of echoing it", () => {
    const en = stringsFor("en");
    const hostile = "<img src=x onerror=alert(1)>" as ReviewReducerErrorCode;
    expect(reducerErrorMessage(hostile, en)).toBe("Not saved: the review is unchanged");
    expect(reducerErrorMessage("FUTURE_PROTOCOL_CODE" as ReviewReducerErrorCode, en))
      .toBe("Not saved: the review is unchanged");
  });
});
