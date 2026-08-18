import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

interface LegacySurfaceModule {
  PLANNING_RECORD_PATHS: readonly string[];
  isHistoricalTestPath(path: string): boolean;
  isPlanningRecordPath(path: string): boolean;
  runSelfTests(): void;
  scanLogicalText(logicalPath: string, text: string, displayPath?: string): unknown[];
  scanRepositorySurfaces(): Promise<{ allowedHits: unknown[]; scanned: string[] }>;
}

// The executable tool remains plain ESM; this local contract keeps the product
// TypeScript graph independent from build-tool implementation details.
// @ts-expect-error The runtime .mjs tool intentionally has no published TS declarations.
const scanner = (await import("../../tools/scan-legacy-surface.mjs")) as LegacySurfaceModule;

// Assembled at runtime so this file never carries a literal retired marker.
const legacyContract = ["dual-audience", "report-contract", "v1"].join("-");
const retiredSuffix = ["_HUMAN", ".html"].join("");
const retiredScript = ["init", "delivery.py"].join("_");

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

describe("legacy surface scan over the real tracked tree", () => {
  test("the current public surface passes the release gate", async () => {
    const { scanned, allowedHits } = await scanner.scanRepositorySurfaces();

    expect(scanned).toContain("README.md");
    expect(scanned).toContain("skills/deliver-dual-audience-report/SKILL.md");
    expect(scanned).toContain("src/cli/validate/text.ts");
    expect(allowedHits.length).toBeGreaterThan(0);
  });

  test("planning records are excluded but every other tracked document is scanned", async () => {
    const { scanned } = await scanner.scanRepositorySurfaces();
    const scannedDocuments = scanned.filter((path) => path.startsWith("docs/"));
    const trackedDocuments = trackedFiles().filter((path) => path.startsWith("docs/"));

    expect(trackedDocuments.length).toBeGreaterThan(scanner.PLANNING_RECORD_PATHS.length);
    expect(scannedDocuments.sort()).toEqual(
      trackedDocuments.filter((path) => !scanner.PLANNING_RECORD_PATHS.includes(path)).sort(),
    );
    for (const path of scanner.PLANNING_RECORD_PATHS) {
      expect(scannedDocuments).not.toContain(path);
    }
  });

  test("every exempted planning record is still a tracked file", () => {
    const tracked = new Set(trackedFiles());
    for (const path of scanner.PLANNING_RECORD_PATHS) {
      expect(tracked.has(path)).toBe(true);
    }
  });
});

describe("legacy surface boundary predicates", () => {
  test("the planning record boundary is an exact path list, not a docs prefix", () => {
    expect([...scanner.PLANNING_RECORD_PATHS].sort()).toEqual([
      "docs/design.md",
      "docs/spec.md",
      "docs/task.md",
    ]);
    for (const path of scanner.PLANNING_RECORD_PATHS) {
      expect(scanner.isPlanningRecordPath(path)).toBe(true);
    }
    for (const path of [
      "docs/README.md",
      "docs/claude-code-handoff.md",
      "docs/archive/spec.md",
      "docs/spec.md.bak",
      "spec.md",
      "",
    ]) {
      expect(scanner.isPlanningRecordPath(path)).toBe(false);
    }
  });

  test("the historical test boundary stays independent of the planning record boundary", () => {
    expect(scanner.isHistoricalTestPath("tests/unit/legacy-surface.test.ts")).toBe(true);
    expect(scanner.isPlanningRecordPath("tests/unit/legacy-surface.test.ts")).toBe(false);
    expect(scanner.isHistoricalTestPath("docs/spec.md")).toBe(false);
  });
});

describe("legacy surface rejection outside the exempted boundary", () => {
  test("a new tracked document may not carry retired public markers", () => {
    expect(() => scanner.scanLogicalText("docs/claude-code-handoff.md", `carrier ${legacyContract}`))
      .toThrow(/escaped an exact rejection or migration context/u);
    expect(() => scanner.scanLogicalText("docs/README.md", `output ${retiredSuffix}`))
      .toThrow(/retired human artifact suffix/u);
    expect(() => scanner.scanLogicalText("docs/new-guide.md", `run ${retiredScript}`))
      .toThrow(/retired filename remains on an active public surface/u);
  });

  test("the scanner self-test suite passes", () => {
    expect(() => scanner.runSelfTests()).not.toThrow();
  });
});
