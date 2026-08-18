import { describe, expect, it } from "vitest";
import { validatePrivateData } from "../../src/cli/validate.js";
import { validatePrivateText } from "../../src/cli/validate/privacy.js";

describe("privacy validator", () => {
  it("allows public identifiers, ordinary URLs, UUID evidence, and support language", () => {
    const input = {
      documentId: "RD-22222222222222222222",
      evidence: "Public case 123e4567-e89b-12d3-a456-426614174000",
      url: "https://example.com/docs?q=safe",
      note: "A support session can be scheduled without recording its identifier.",
    };
    expect(validatePrivateData(input)).toEqual({ ok: true, value: true });
    expect(validatePrivateText("No private content is present.", "/text")).toEqual({ ok: true, value: true });
  });

  it("keeps relative paths and public URL segments out of the personal-path rule", () => {
    // Only an absolute home path is personal. A `Users`/`home` segment inside a
    // relative path or a public URL must never be reported.
    const legitimate = [
      ["reports/2026", "report.md"].join("/"),
      ["docs", "home", "index.md"].join("/"),
      ["src", "Users", "profile.tsx"].join("/"),
      ["https://docs.example.test", "home", "getting-started"].join("/"),
      ["https://docs.example.test", "Users", "guide"].join("/"),
      ["见 ", ["docs", "home", "index.md"].join("/"), " 获取详情"].join(""),
    ];
    for (const value of legitimate) {
      expect(validatePrivateText(value, "/text"), value).toEqual({ ok: true, value: true });
    }
    expect(validatePrivateData({ paths: legitimate })).toEqual({ ok: true, value: true });
  });

  it.each([
    ["Author", "ization: Bearer abcdefghijklmnopqrstuvwxyz"].join(""),
    "Bearer abcdefghijklmnopqrstuvwxyz",
    ["s", "k-abcdefghijklmnopqrstuvwxyz"].join(""),
    ["g", "hp_abcdefghijklmnopqrstuvwxyz"].join(""),
    ["A", "KIAABCDEFGHIJKLMNOP"].join(""),
    "xoxb-12345678901234567890",
    "api_key=abcdefghijk",
    "https://username:password@example.com/private",
    ["file:///Use", "rs/person/project/input.json"].join(""),
    ["/Use", "rs/person/project/input.json"].join(""),
    "C:\\Users\\person\\project\\input.json",
    // A bare home directory never reaches a trailing separator.
    ["/Use", "rs/alice"].join(""),
    ["/ho", "me/bob"].join(""),
    ["C:\\Use", "rs\\alice"].join(""),
    // Any character may precede an absolute personal path, including the CJK
    // adjacency that is ordinary typography for this Chinese-first product.
    ["path=/Use", "rs/alice/notes.md"].join(""),
    ["**/Use", "rs/alice/notes.md**"].join(""),
    ["见/Use", "rs/alice/notes.md"].join(""),
    ["见/ho", "me/bob/notes.md"].join(""),
    ["见C:\\Use", "rs\\alice\\notes.md"].join(""),
    ["session", "-id=123e4567-e89b-12d3-a456-426614174000"].join(""),
    "raw conversation transcript",
  ])("rejects prohibited content without echoing it: %s", (privateValue) => {
    const privateKey = ["sec", "ret"].join("");
    const result = validatePrivateData({ nested: [{ [privateKey]: privateValue }] });
    expect(result).toEqual({
      ok: false,
      errors: [{
        code: "PRIVACY_VIOLATION",
        path: "/nested/0/secret",
        blockId: null,
        message: expect.any(String),
        hint: expect.any(String),
      }],
    });
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  it("escapes JSON Pointer segments and rejects cycles without traversing live input", () => {
    const escaped = validatePrivateData({ "a/b~c": "password=abcdefghijk" });
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.errors[0]?.path).toBe("/a~1b~0c");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = validatePrivateData(cyclic);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toEqual(expect.objectContaining({
      code: "SCHEMA_TYPE",
      path: "",
    }));
  });

  it("does not echo a prohibited object key in its own error path", () => {
    const sentinel = ["Author", "ization: Bearer private-key-abcdefgh"].join("");
    const result = validatePrivateData({ [sentinel]: "value" });
    expect(result).toEqual({
      ok: false,
      errors: [expect.objectContaining({ code: "PRIVACY_VIOLATION", path: "" })],
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});
