import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

// The CI browser lanes run inside the official Playwright container image, so
// browsers and their system libraries come from the image instead of
// `playwright install` + apt. That removes the degraded apt mirror from the job
// graph entirely, but couples the workflow to the npm package: an image whose
// version differs from @playwright/test cannot locate the browser executables
// and fails every lane. This suite turns that lockstep from a convention into
// an executable gate.

const workflow = readFileSync(resolve(ROOT, ".github/workflows/validate.yml"), "utf8");

const packageLock = JSON.parse(
  readFileSync(resolve(ROOT, "package-lock.json"), "utf8"),
) as {
  packages: Record<string, { version?: string } | undefined>;
};

const IMAGE_PATTERN =
  /image:\s*mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:([0-9a-f]{64})/gu;

describe("Playwright container image lockstep", () => {
  const references = [...workflow.matchAll(IMAGE_PATTERN)];

  test("both browser lanes pin the container image by version and digest", () => {
    // One reference for the browser matrix job, one for firefox-smoke.
    expect(references).toHaveLength(2);
  });

  test("every image reference is byte-identical", () => {
    const distinct = new Set(references.map((match) => match[0]));
    expect(distinct.size).toBe(1);
  });

  test("the image version equals the locked @playwright/test version", () => {
    const locked = packageLock.packages["node_modules/@playwright/test"]?.version;
    expect(locked).toBeDefined();
    for (const match of references) {
      expect(match[1]).toBe(locked);
    }
  });

  test("each container block carries the required runtime options", () => {
    // `--user 1001` keeps the mounted tool cache writable and lets Firefox
    // start; `--ipc=host` prevents Chromium shared-memory crashes.
    const optionLines = workflow.match(/options:\s*--user 1001 --ipc=host/gu) ?? [];
    expect(optionLines).toHaveLength(references.length);
  });

  test("no lane installs browsers or system dependencies at run time", () => {
    expect(workflow).not.toMatch(/playwright\s+install/u);
    expect(workflow).not.toMatch(/install-playwright\.sh/u);
    expect(workflow).not.toMatch(/ms-playwright/u);
  });
});
