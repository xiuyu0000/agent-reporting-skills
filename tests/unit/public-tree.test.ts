import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const privateUsername = ["star", "spulse"].join("");
const patterns = {
  credential:
    /(?:\bgh[pousr]_[a-z0-9]{20,}\b|\bsk-[a-z0-9_-]{20,}\b|\bAKIA[A-Z0-9]{16}\b|\bauthorization\s*:\s*[^\r\n]{8,}|\b(?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*["']?[^\s"']{12,}|\bcookie\s*:\s*[^\s;]{12,})/iu,
  "personal absolute path":
    /(?:file:\/\/(?:\/[^/\s]+|[^/\s]+)\/[^\s]+|\/Users\/(?!example(?:\/|\b))[a-z0-9._-]+\/|\/home\/(?!example(?:\/|\b))[a-z0-9._-]+\/|[A-Z]:\\Users\\(?!example(?:\\|\b))[a-z0-9._-]+\\)/iu,
  "personal username": new RegExp(`\\b${privateUsername}\\b`, "iu"),
  "session id":
    /\b(?:session(?:[_ -]?id)?|codex[_ -]?session)\s*["']?\s*[:=]\s*["']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
} as const;

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

function readTrackedText(path: string): string | undefined {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return undefined;
  return bytes.toString("utf8");
}

describe("tracked public tree privacy boundary", () => {
  test("scans only tracked text and reports location without secret content", () => {
    const files = trackedFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((path) => path.startsWith("docs/调研/"))).toBe(false);

    const violations: string[] = [];
    for (const path of files) {
      const absolutePath = resolve(ROOT, path);
      if (!existsSync(absolutePath)) continue;
      const text = readTrackedText(absolutePath);
      if (text === undefined) continue;
      for (const [kind, pattern] of Object.entries(patterns)) {
        if (pattern.test(text)) violations.push(`${kind}: ${path}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("keeps synthetic negative protections and does not treat an ordinary UUID as a session", () => {
    const uuid = ["019f3cd2", "1e87", "73b0", "873b", "c3b68142073f"].join("-");
    const samples: Record<keyof typeof patterns, string> = {
      credential: ["api", "key"].join("_") + "=" + "a".repeat(24),
      "personal absolute path": ["file:", "", "", "home", "alice", "private", "report.md"].join("/"),
      "personal username": `owner=${privateUsername}`,
      "session id": `{"session_id":"${uuid}"}`,
    };
    for (const [kind, sample] of Object.entries(samples)) {
      expect(patterns[kind as keyof typeof patterns].test(sample), kind).toBe(true);
    }
    expect(patterns["session id"].test(`https://support.example.test/article/${uuid}`)).toBe(false);
    const additionalCredentials = [
      ["Authorization", "Basic " + "dXNlcjpwYXNzd29yZA=="].join(": "),
      ["password", "hunter2-long-secret"].join("="),
    ];
    for (const sample of additionalCredentials) {
      expect(patterns.credential.test(sample)).toBe(true);
    }
    const additionalPaths = [
      ["", "home", "alice", "private", "report.md"].join("/"),
      ["file:", "", "server", "private", "report.md"].join("/"),
    ];
    for (const sample of additionalPaths) {
      expect(patterns["personal absolute path"].test(sample)).toBe(true);
    }
  });

  test("progressive CI recognizes both Playwright test suffixes beyond bootstrap", () => {
    const workflow = readFileSync(resolve(ROOT, ".github/workflows/validate.yml"), "utf8");
    expect(workflow).toContain("-name '*.spec.ts' -o -name '*.test.ts'");
    expect(workflow).toContain("! -name 'bootstrap.spec.ts'");
    expect(workflow).toContain("npm run test:browser");
  });
});
