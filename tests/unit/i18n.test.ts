import { describe, expect, it } from "vitest";
import {
  SUPPORTED_UI_LOCALES,
  assertCompleteLocaleTables,
  isUiLocale,
  stringsFor,
} from "../../src/workbench/i18n.js";

describe("workbench locale tables", () => {
  it("keeps zh-CN and en complete with the same closed key set", () => {
    expect(() => assertCompleteLocaleTables()).not.toThrow();
    expect(SUPPORTED_UI_LOCALES).toEqual(["zh-CN", "en"]);
    expect(Object.keys(stringsFor("zh-CN")).sort()).toEqual(Object.keys(stringsFor("en")).sort());
    expect(stringsFor("zh-CN").skipToMain).toBe("跳到决策块");
    expect(stringsFor("en").skipToMain).toBe("Skip to decision blocks");
    expect(stringsFor("zh-CN").showDefinition).toBe("展开定义");
    expect(stringsFor("en").glossaryJump).toBe("Go to glossary");
  });

  it("does not silently fall back for an unknown locale", () => {
    expect(isUiLocale("zh-CN")).toBe(true);
    expect(isUiLocale("en")).toBe(true);
    expect(isUiLocale("en-US")).toBe(false);
    expect(isUiLocale("fr")).toBe(false);
  });
});
