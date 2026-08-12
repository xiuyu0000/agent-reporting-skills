import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ReviewDocumentV1 } from "../../../src/protocol/index.js";

export async function approvalTemplateBytes(): Promise<Uint8Array> {
  return readFile(resolve(
    "skills/deliver-dual-audience-report/assets/review-workbench.template.html",
  ));
}

export async function reviewDocumentFixture(): Promise<ReviewDocumentV1> {
  return JSON.parse(await readFile(
    resolve("tests/fixtures/protocol/review-document.json"),
    "utf8",
  )) as ReviewDocumentV1;
}

export async function createPrivateDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

export async function writePrivate(path: string, value: string | Uint8Array): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}
