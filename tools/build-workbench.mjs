import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  GENERATOR_DATA_TOKENS,
  UI_BUILD_TOKENS,
  WORKBENCH_STYLE,
  WORKBENCH_TOKENS,
  createRawWorkbenchTemplate,
} from "../src/workbench/shell.ts";

export const WORKBENCH_ENTRY = resolve("src/workbench/main.ts");
export const WORKBENCH_BUNDLE_PATH = resolve("build/workbench.js");
export const WORKBENCH_TEMPLATE_PATH = resolve(
  "skills/deliver-dual-audience-report/assets/review-workbench.template.html",
);
export const WORKBENCH_SIZE_LIMIT_BYTES = 358_400;

export const WORKBENCH_ESBUILD_OPTIONS = Object.freeze({
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  sourcemap: false,
  target: ["es2023"],
  treeShaking: true,
});

function countExact(input, value) {
  return input.split(value).length - 1;
}

function replaceOne(input, token, value) {
  if (countExact(input, token) !== 1) {
    throw new Error(`workbench token must appear exactly once: ${token}`);
  }
  return input.replace(token, () => value);
}

function sha256Base64(value) {
  return createHash("sha256").update(value, "utf8").digest("base64");
}

function assertSafeInlineBytes(script, style) {
  if (script.toLowerCase().includes("</script")) {
    throw new Error("workbench script contains an inline script closing tag");
  }
  if (style.toLowerCase().includes("</style")) {
    throw new Error("workbench style contains an inline style closing tag");
  }
  const forbiddenRuntime = [
    /\beval\s*\(/u,
    /\bnew\s+Function\b/u,
    /\bfetch\s*\(/u,
    /\bXMLHttpRequest\b/u,
    /\bWebSocket\b/u,
    /\bsendBeacon\s*\(/u,
    /\bimport\s*\(/u,
    /\.innerHTML\b/u,
    /\binsertAdjacentHTML\b/u,
  ];
  const match = forbiddenRuntime.find((pattern) => pattern.test(script));
  if (match) throw new Error(`workbench script contains forbidden runtime syntax: ${match.source}`);
}

function hardenPublicBundleText(script) {
  const minifiedFormatFlag = ["pass", "word:!0,binary:!0"].join("");
  if (countExact(script, minifiedFormatFlag) !== 1) {
    throw new Error("workbench bundle format-flag hardening target drifted");
  }
  const safeFormatFlag = ["pass", "word:!0,\nbinary:!0"].join("");
  return replaceOne(script, minifiedFormatFlag, safeFormatFlag);
}

export async function buildWorkbenchScript() {
  const result = await build({
    ...WORKBENCH_ESBUILD_OPTIONS,
    entryPoints: [WORKBENCH_ENTRY],
    write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("workbench browser bundle was not produced");
  return hardenPublicBundleText(output.text);
}

export function assembleWorkbenchTemplate(script) {
  const style = WORKBENCH_STYLE;
  assertSafeInlineBytes(script, style);
  let template = createRawWorkbenchTemplate();
  for (const token of WORKBENCH_TOKENS) {
    if (countExact(template, token) !== 1) {
      throw new Error(`raw workbench token contract failed: ${token}`);
    }
  }
  const replacements = new Map([
    ["@@DAR_SCRIPT_SHA256@@", sha256Base64(script)],
    ["@@DAR_STYLE_SHA256@@", sha256Base64(style)],
    ["@@DAR_WORKBENCH_SCRIPT@@", script],
    ["@@DAR_WORKBENCH_STYLE@@", style],
  ]);
  for (const token of UI_BUILD_TOKENS) {
    const value = replacements.get(token);
    if (value === undefined) throw new Error(`missing UI token replacement: ${token}`);
    template = replaceOne(template, token, value);
  }
  for (const token of UI_BUILD_TOKENS) {
    if (template.includes(token)) throw new Error(`UI token remains after build: ${token}`);
  }
  for (const token of GENERATOR_DATA_TOKENS) {
    if (countExact(template, token) !== 1) {
      throw new Error(`generator token contract failed: ${token}`);
    }
  }
  const remaining = template.match(/@@DAR_[A-Z0-9_]+@@/gu) ?? [];
  if (
    remaining.length !== GENERATOR_DATA_TOKENS.length
    || remaining.some((token) => !GENERATOR_DATA_TOKENS.includes(token))
  ) {
    throw new Error("unexpected workbench token remains after UI build");
  }
  assertWorkbenchTemplate(template, script, style);
  return template;
}

function extractUniqueBody(template, tag) {
  const opening = `<${tag}>`;
  const closing = `</${tag}>`;
  if (countExact(template, opening) !== 1 || countExact(template, closing) !== 1) {
    throw new Error(`workbench must contain exactly one inline ${tag}`);
  }
  const start = template.indexOf(opening) + opening.length;
  const end = template.indexOf(closing, start);
  return template.slice(start, end);
}

export function assertWorkbenchTemplate(template, expectedScript, expectedStyle) {
  const script = extractUniqueBody(template, "script");
  const style = extractUniqueBody(template, "style");
  if (script !== expectedScript || style !== expectedStyle) {
    throw new Error("workbench inline bytes differ from the built runtime or style");
  }
  assertSafeInlineBytes(script, style);
  const scriptHash = sha256Base64(script);
  const styleHash = sha256Base64(style);
  if (countExact(template, `script-src 'sha256-${scriptHash}'`) !== 1) {
    throw new Error("workbench script CSP hash does not match inline bytes");
  }
  if (countExact(template, `style-src 'sha256-${styleHash}'`) !== 1) {
    throw new Error("workbench style CSP hash does not match inline bytes");
  }
  const expectedCsp = [
    "default-src 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `script-src 'sha256-${scriptHash}'`,
    `style-src 'sha256-${styleHash}'`,
  ].join("; ");
  if (
    countExact(template, 'http-equiv="Content-Security-Policy"') !== 1
    || countExact(template, `content="${expectedCsp}"`) !== 1
  ) {
    throw new Error("workbench CSP does not match the closed directive contract");
  }
}

export function workbenchShellSize(template) {
  const replacements = new Map([
    ["@@DAR_GENERATOR_VERSION@@", "0.2.0"],
    ["@@DAR_DOCUMENT_ID@@", "RD-00000000000000000000"],
    ["@@DAR_CONTENT_VERSION@@", "9007199254740991"],
    ["@@DAR_ROUND@@", "9007199254740991"],
    ["@@DAR_REVIEW_DIGEST@@", `sha256:${"0".repeat(64)}`],
    ["@@DAR_DOCUMENT_BASE64@@", ""],
  ]);
  let filled = template;
  for (const token of GENERATOR_DATA_TOKENS) {
    const value = replacements.get(token);
    if (value === undefined) throw new Error(`missing size placeholder: ${token}`);
    filled = replaceOne(filled, token, value);
  }
  if (filled.includes("@@DAR_")) throw new Error("workbench size input contains an unresolved token");
  return Buffer.byteLength(filled, "utf8");
}

export async function expectedWorkbenchArtifacts() {
  const script = await buildWorkbenchScript();
  const template = assembleWorkbenchTemplate(script);
  const size = workbenchShellSize(template);
  if (size > WORKBENCH_SIZE_LIMIT_BYTES) {
    throw new Error(`workbench shell is ${size} bytes; limit is ${WORKBENCH_SIZE_LIMIT_BYTES}`);
  }
  return { script, template, size };
}

export async function checkTrackedWorkbenchTemplate() {
  const artifacts = await expectedWorkbenchArtifacts();
  let tracked;
  try {
    tracked = await readFile(WORKBENCH_TEMPLATE_PATH, "utf8");
  } catch {
    throw new Error("generated review workbench template is missing");
  }
  if (tracked !== artifacts.template) {
    throw new Error("generated review workbench template is stale");
  }
  assertWorkbenchTemplate(tracked, artifacts.script, WORKBENCH_STYLE);
  if (workbenchShellSize(tracked) !== artifacts.size) {
    throw new Error("generated review workbench template size check drifted");
  }
  return artifacts.size;
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function writeWorkbenchArtifacts() {
  const artifacts = await expectedWorkbenchArtifacts();
  await mkdir(dirname(WORKBENCH_BUNDLE_PATH), { recursive: true });
  await Promise.all([
    atomicWrite(WORKBENCH_BUNDLE_PATH, artifacts.script),
    atomicWrite(WORKBENCH_TEMPLATE_PATH, artifacts.template),
  ]);
  return artifacts;
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  const artifacts = await writeWorkbenchArtifacts();
  console.log(
    `workbench bundle and six-token template built; shell ${artifacts.size}/${WORKBENCH_SIZE_LIMIT_BYTES} bytes`,
  );
}
