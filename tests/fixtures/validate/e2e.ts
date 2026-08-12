import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";
import {
  runValidateCommand,
  type ValidateCommandResult,
} from "../../../src/cli/validate.js";
import { approvalTemplateBytes } from "./helpers.js";

const temporaryDirectories: string[] = [];
let driverPath: string | undefined;

export async function temporaryDirectory(label: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(process.cwd(), `.dar-${label}-`)));
  await chmod(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}

export async function cleanupTemporaryDirectories(): Promise<void> {
  driverPath = undefined;
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
}

export async function writePrivateFile(path: string, value: string | Uint8Array): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function buildDriver(): Promise<string> {
  if (driverPath !== undefined) return driverPath;
  const root = await temporaryDirectory("validate-driver");
  driverPath = join(root, "driver.mjs");
  await build({
    bundle: true,
    entryPoints: [resolve("tests/fixtures/validate/subprocess-driver.ts")],
    format: "esm",
    outfile: driverPath,
    platform: "node",
    sourcemap: false,
    target: "node24",
  });
  await chmod(driverPath, 0o600);
  return driverPath;
}

export async function runValidate(arguments_: readonly string[]): Promise<{
  status: number;
  stderr: string;
  result: ValidateCommandResult;
}> {
  const direct = await runValidateCommand(arguments_, {
    approvalTemplateBytes: approvalTemplateBytes(),
  });
  const driver = await buildDriver();
  const subprocess = spawnSync(process.execPath, [driver, ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (subprocess.error) throw subprocess.error;
  const lines = subprocess.stdout.trimEnd().split("\n");
  if (lines.length !== 1) throw new Error(`unexpected stdout line count: ${lines.length}`);
  const result = JSON.parse(lines[0] ?? "") as ValidateCommandResult;
  if (subprocess.status !== direct.exitCode || JSON.stringify(result) !== JSON.stringify(direct.result)) {
    throw new Error("direct and subprocess validate outcomes diverged");
  }
  return {
    status: subprocess.status ?? 70,
    stderr: subprocess.stderr,
    result,
  };
}

export async function runValidateHostileThrow(sentinel: string): Promise<{
  status: number;
  stderr: string;
  result: ValidateCommandResult;
}> {
  const driver = await buildDriver();
  const subprocess = spawnSync(process.execPath, [driver], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", DAR_VALIDATE_TEST_THROW: sentinel },
  });
  if (subprocess.error) throw subprocess.error;
  const lines = subprocess.stdout.trimEnd().split("\n");
  if (lines.length !== 1) throw new Error(`unexpected stdout line count: ${lines.length}`);
  return {
    status: subprocess.status ?? 70,
    stderr: subprocess.stderr,
    result: JSON.parse(lines[0] ?? "") as ValidateCommandResult,
  };
}

export interface TreeEntry {
  relativePath: string;
  kind: "directory" | "file" | "symlink" | "other";
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  digest?: string;
  linkTarget?: string;
}

export async function snapshotTree(root: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(path: string): Promise<void> {
    const metadata = await lstat(path);
    const common = {
      relativePath: relative(root, path) || ".",
      dev: metadata.dev,
      ino: metadata.ino,
      mode: metadata.mode,
      nlink: metadata.nlink,
      size: metadata.size,
    };
    if (metadata.isSymbolicLink()) {
      entries.push({ ...common, kind: "symlink", linkTarget: await readlink(path) });
      return;
    }
    if (metadata.isDirectory()) {
      entries.push({ ...common, kind: "directory" });
      const children = await readdir(path);
      children.sort();
      for (const child of children) await visit(join(path, child));
      return;
    }
    if (metadata.isFile()) {
      const bytes = await readFile(path);
      entries.push({
        ...common,
        kind: "file",
        digest: createHash("sha256").update(bytes).digest("hex"),
      });
      return;
    }
    entries.push({ ...common, kind: "other" });
  }
  await visit(root);
  return entries;
}

export async function makeInputRoot(parent: string, name = "input"): Promise<string> {
  const root = join(parent, name);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  return root;
}
