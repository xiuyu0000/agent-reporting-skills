import { expect, test } from "@playwright/test";

test("@bootstrap declares a supported browser project", async ({ browserName }, testInfo) => {
  expect(testInfo.project.name).toBe(browserName);
});
