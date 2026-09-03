import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface ReleaseEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly bytes: Buffer;
  readonly byteLength: number;
  readonly digest: string;
}

interface ReleaseCandidate {
  readonly zipBytes: Buffer;
  readonly manifestBytes: Buffer;
  readonly manifest: unknown;
  readonly entries: readonly ReleaseEntry[];
}

interface ReleaseModule {
  readonly RELEASE_MANIFEST_PATH: string;
  readonly RELEASE_TRANSACTION_DIR: string;
  readonly RELEASE_VERSION: string;
  readonly RELEASE_ZIP_PATH: string;
  readonly SKILL_FILES: readonly string[];
  readonly SKILL_NAME: string;
  buildReleaseCandidate(options?: {
    skillRoot?: string;
    version?: string;
    onSnapshotCheckpoint?: (phase: string) => void | Promise<void>;
  }): Promise<ReleaseCandidate>;
  parseDeterministicZip(bytes: Uint8Array): ReleaseEntry[];
  writeReleaseCandidate(options?: {
    skillRoot?: string;
    version?: string;
    onCheckpoint?: (phase: string) => void | Promise<void>;
  }): Promise<ReleaseCandidate>;
}

interface VerifyModule {
  materializeReleaseEntries(entries: readonly ReleaseEntry[], physicalRoot: string): Promise<string>;
  materializeReleaseEntries(
    entries: readonly ReleaseEntry[],
    physicalRoot: string,
    options: {
      onCheckpoint(checkpoint: {
        phase: string;
        relativePath: string;
        rootPath: string;
        skillRoot: string;
        parentPath: string;
        targetPath: string;
      }): void | Promise<void>;
    },
  ): Promise<string>;
  assertCanonicalReleaseManifestBytes(manifestBytes: Buffer, zipBytes: Buffer, entries: readonly ReleaseEntry[]): Buffer;
  closeReleasePairSession(session: unknown): Promise<void>;
  closeSourceSnapshotSession(session: unknown): Promise<void>;
  openReleasePairSession(options?: { repositoryRoot?: string }): Promise<{
    zipBytes: Buffer;
    manifestBytes: Buffer;
  }>;
  openSourceSnapshotSession(skillRoot: string): Promise<{ entries: readonly ReleaseEntry[] }>;
  readStableReleasePair(): Promise<{ zipBytes: Buffer; manifestBytes: Buffer }>;
  rereadReleasePairSession(session: unknown): Promise<{ zipBytes: Buffer; manifestBytes: Buffer }>;
  rereadSourceSnapshotSession(session: unknown): Promise<{ entries: readonly ReleaseEntry[] }>;
  runManifestAdversarialChecks(manifest: unknown, zipBytes: Buffer, entries: readonly ReleaseEntry[]): void;
  runParserAdversarialChecks(zipBytes: Buffer): void;
  runBoundedProcess(
    executable: string,
    arguments_: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; outputLimitBytes?: number },
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
  runSubprocessAdversarialChecks(node: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<void>;
  validateReleaseManifest(manifest: unknown, zipBytes: Buffer, entries: readonly ReleaseEntry[]): unknown;
  verifyPackageContractAcrossOperation<T>(packagePath: string, operation: () => Promise<T>): Promise<T>;
  verifyDistribution(options?: {
    repositoryRoot?: string;
    skillRoot?: string;
    onTerminalCheckpoint?: (checkpoint: {
      phase: string;
      repositoryRoot: string;
      skillRoot: string;
      packagePath: string;
      zipPath: string;
      manifestPath: string;
    }) => void | Promise<void>;
  }): Promise<{
    version: string;
    entryCount: number;
    byteLength: number;
    digest: string;
    node: string;
  }>;
}

const roots: string[] = [];
const releaseModulePath = fileURLToPath(new URL("../../tools/release-build.mjs", import.meta.url));
const verifyModulePath = fileURLToPath(new URL("../../tools/verify-dist.mjs", import.meta.url));
const verifyModuleSpecifier = pathToFileURL(verifyModulePath).href;
const importUnknown = (specifier: string): Promise<unknown> => import(specifier);

async function releaseModule(specifier = pathToFileURL(releaseModulePath).href): Promise<ReleaseModule> {
  return await importUnknown(specifier) as ReleaseModule;
}

async function verifyModule(specifier = verifyModuleSpecifier): Promise<VerifyModule> {
  return await importUnknown(specifier) as VerifyModule;
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `dar-release-${label}-`)));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

async function physicalSkill(label: string): Promise<string> {
  const release = await releaseModule();
  const root = await temporaryRoot(label);
  const destination = join(root, "copied-skill");
  await cp(resolve("skills", release.SKILL_NAME), destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: false,
  });
  return destination;
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

interface ReleaseSandbox {
  readonly root: string;
  readonly module: ReleaseModule;
  readonly verifier: VerifyModule;
  readonly skillRoot: string;
}

async function releaseSandbox(label: string): Promise<ReleaseSandbox> {
  const release = await releaseModule();
  const root = await temporaryRoot(label);
  const tools = join(root, "tools");
  const skillRoot = join(root, "skills", release.SKILL_NAME);
  await mkdir(tools, { recursive: true });
  await mkdir(dirname(skillRoot), { recursive: true });
  await cp(releaseModulePath, join(tools, "release-build.mjs"));
  await cp(verifyModulePath, join(tools, "verify-dist.mjs"));
  await cp(resolve("package.json"), join(root, "package.json"));
  await cp(resolve("skills", release.SKILL_NAME), skillRoot, {
    recursive: true,
    dereference: false,
    preserveTimestamps: false,
  });
  const specifier = `${pathToFileURL(join(tools, "release-build.mjs")).href}?sandbox=${encodeURIComponent(label)}`;
  const verifierSpecifier = `${pathToFileURL(join(tools, "verify-dist.mjs")).href}?sandbox=${encodeURIComponent(label)}`;
  return {
    root,
    module: await releaseModule(specifier),
    verifier: await verifyModule(verifierSpecifier),
    skillRoot,
  };
}

async function snapshotPair(sandbox: ReleaseSandbox): Promise<{ zip: Buffer; manifest: Buffer }> {
  return {
    zip: await readFile(join(sandbox.root, sandbox.module.RELEASE_ZIP_PATH)),
    manifest: await readFile(join(sandbox.root, sandbox.module.RELEASE_MANIFEST_PATH)),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("REL-001 release candidate", () => {
  it("materializes only the exact entries into distinct physical roots and ignores an unlisted hostile item", async () => {
    const release = await releaseModule();
    const verify = await verifyModule();
    const [firstRoot, secondRoot] = await Promise.all([physicalSkill("root-a"), physicalSkill("root-b")]);
    const hostilePath = join(firstRoot, "ignored-hostile-item");
    await symlink(join(firstRoot, "missing-hostile-target"), hostilePath);
    expect((await lstat(hostilePath)).isSymbolicLink()).toBe(true);
    const first = await release.buildReleaseCandidate({ skillRoot: firstRoot, version: release.RELEASE_VERSION });
    const second = await release.buildReleaseCandidate({ skillRoot: secondRoot, version: release.RELEASE_VERSION });
    const [boundedParentA, boundedParentB] = await Promise.all([
      temporaryRoot("bounded-root-a"),
      temporaryRoot("bounded-root-b"),
    ]);
    const [boundedRootA, boundedRootB] = await Promise.all([
      verify.materializeReleaseEntries(first.entries, boundedParentA),
      verify.materializeReleaseEntries(first.entries, boundedParentB),
    ]);
    expect(await pathIsAbsent(join(boundedRootA, "ignored-hostile-item"))).toBe(true);
    expect(await pathIsAbsent(join(boundedRootB, "ignored-hostile-item"))).toBe(true);
    const rejectedParent = await temporaryRoot("bounded-hostile-metadata");
    const hostileEntries = first.entries.map((entry, index) => index === 0
      ? { ...entry, bytes: Buffer.concat([entry.bytes, Buffer.from([0])]) }
      : entry);
    await expect(verify.materializeReleaseEntries(hostileEntries, rejectedParent)).rejects.toThrow(/entry exceeds its byte limit/u);
    expect(await pathIsAbsent(join(rejectedParent, "skill"))).toBe(true);
    const swapParent = await temporaryRoot("bounded-parent-swap");
    const outsideRoot = await temporaryRoot("bounded-parent-outside");
    const outsideModeBefore = (await lstat(outsideRoot, { bigint: true })).mode & 0o777n;
    let swappedParent = false;
    await expect(verify.materializeReleaseEntries(first.entries, swapParent, {
      async onCheckpoint(checkpoint) {
        if (swappedParent || checkpoint.phase !== "after-parent-precheck" || !checkpoint.relativePath.startsWith("assets/")) return;
        swappedParent = true;
        const parkedParent = `${checkpoint.parentPath}.parked`;
        await rename(checkpoint.parentPath, parkedParent);
        await symlink(outsideRoot, checkpoint.parentPath);
      },
    })).rejects.toThrow(/private directory|binding|canonical/u);
    expect(swappedParent).toBe(true);
    expect(await pathIsAbsent(join(outsideRoot, "agent-context.template.md"))).toBe(true);
    expect((await lstat(outsideRoot, { bigint: true })).mode & 0o777n).toBe(outsideModeBefore);
    const [boundedFirst, boundedSecond] = await Promise.all([
      release.buildReleaseCandidate({ skillRoot: boundedRootA, version: release.RELEASE_VERSION }),
      release.buildReleaseCandidate({ skillRoot: boundedRootB, version: release.RELEASE_VERSION }),
    ]);
    const tracked = await verify.readStableReleasePair();
    expect(first.zipBytes.equals(second.zipBytes)).toBe(true);
    expect(first.manifestBytes.equals(second.manifestBytes)).toBe(true);
    expect(boundedFirst.zipBytes.equals(first.zipBytes)).toBe(true);
    expect(boundedSecond.zipBytes.equals(first.zipBytes)).toBe(true);
    expect(boundedFirst.manifestBytes.equals(first.manifestBytes)).toBe(true);
    expect(boundedSecond.manifestBytes.equals(first.manifestBytes)).toBe(true);
    expect(first.zipBytes.equals(tracked.zipBytes)).toBe(true);
    expect(first.manifestBytes.equals(tracked.manifestBytes)).toBe(true);
  });

  it("locks exact inventory, manifest bindings, and every hostile ZIP class", async () => {
    const release = await releaseModule();
    const verify = await verifyModule();
    const pair = await verify.readStableReleasePair();
    const entries = release.parseDeterministicZip(pair.zipBytes);
    expect(entries.map((entry) => entry.relativePath)).toEqual(release.SKILL_FILES);
    const manifest = JSON.parse(pair.manifestBytes.toString("utf8")) as unknown;
    expect(verify.validateReleaseManifest(manifest, pair.zipBytes, entries)).toBe(manifest);
    expect(verify.assertCanonicalReleaseManifestBytes(pair.manifestBytes, pair.zipBytes, entries)).toEqual(pair.manifestBytes);
    const reorderedManifest = Buffer.from(`${JSON.stringify({
      version: (manifest as { version: string }).version,
      format: (manifest as { format: string }).format,
      skill: (manifest as { skill: string }).skill,
      node: (manifest as { node: string }).node,
      archive: (manifest as { archive: unknown }).archive,
      files: (manifest as { files: unknown }).files,
      reproducibility: (manifest as { reproducibility: unknown }).reproducibility,
    }, null, 2)}\n`, "utf8");
    expect(JSON.parse(reorderedManifest.toString("utf8"))).toEqual(manifest);
    expect(() => verify.assertCanonicalReleaseManifestBytes(reorderedManifest, pair.zipBytes, entries)).toThrow(/canonical manifest/u);
    expect(() => verify.runParserAdversarialChecks(pair.zipBytes)).not.toThrow();
    expect(() => verify.runManifestAdversarialChecks(manifest, pair.zipBytes, entries)).not.toThrow();

    const packageRoot = await temporaryRoot("package-binding");
    const packagePath = join(packageRoot, "package.json");
    const originalPackage = await readFile(resolve("package.json"));
    const originalText = originalPackage.toString("utf8");
    const driftedText = originalText
      .replace('"version": "0.2.1"', '"version": "0.2.2"')
      .replace('"node": ">=24 <25"', '"node": ">=23 <25"');
    const driftedPackage = Buffer.from(driftedText, "utf8");
    expect(driftedPackage.byteLength).toBe(originalPackage.byteLength);
    await writeFile(packagePath, originalPackage, { mode: 0o600 });
    const packageBefore = await lstat(packagePath, { bigint: true });
    await expect(verify.verifyPackageContractAcrossOperation(packagePath, async () => {
      await Promise.resolve();
      await writeFile(packagePath, driftedPackage);
      const packageAfter = await lstat(packagePath, { bigint: true });
      expect(packageAfter.ino).toBe(packageBefore.ino);
      expect(packageAfter.size).toBe(packageBefore.size);
    })).rejects.toThrow(/package\.json .*?(?:binding|bytes|version|Node engine|changed)/u);

    const pairSandbox = await releaseSandbox("held-pair-binding");
    await pairSandbox.module.writeReleaseCandidate({ skillRoot: pairSandbox.skillRoot, version: pairSandbox.module.RELEASE_VERSION });
    const pairSession = await verify.openReleasePairSession({ repositoryRoot: pairSandbox.root });
    try {
      const pairZipPath = join(pairSandbox.root, pairSandbox.module.RELEASE_ZIP_PATH);
      const pairZipBefore = await lstat(pairZipPath, { bigint: true });
      const pairZipBytes = await readFile(pairZipPath);
      const driftedZipBytes = Buffer.from(pairZipBytes);
      driftedZipBytes[40] = (driftedZipBytes[40] ?? 0) ^ 0xff;
      await writeFile(pairZipPath, driftedZipBytes);
      const pairZipAfter = await lstat(pairZipPath, { bigint: true });
      expect(pairZipAfter.ino).toBe(pairZipBefore.ino);
      expect(pairZipAfter.size).toBe(pairZipBefore.size);
      await expect(verify.rereadReleasePairSession(pairSession)).rejects.toThrow(/release ZIP/u);
    } finally {
      await verify.closeReleasePairSession(pairSession);
    }

    const sourceSession = await verify.openSourceSnapshotSession(pairSandbox.skillRoot);
    try {
      const sourcePath = join(pairSandbox.skillRoot, "SKILL.md");
      const sourceBefore = await lstat(sourcePath, { bigint: true });
      const sourceBytes = await readFile(sourcePath);
      const driftedSource = Buffer.from(sourceBytes);
      driftedSource[0] = (driftedSource[0] ?? 0) ^ 0x01;
      await writeFile(sourcePath, driftedSource);
      const sourceAfter = await lstat(sourcePath, { bigint: true });
      expect(sourceAfter.ino).toBe(sourceBefore.ino);
      expect(sourceAfter.size).toBe(sourceBefore.size);
      await expect(verify.rereadSourceSnapshotSession(sourceSession)).rejects.toThrow(/release source/u);
    } finally {
      await verify.closeSourceSnapshotSession(sourceSession);
    }

    const builderSandbox = await releaseSandbox("builder-package-binding");
    const builderPackagePath = join(builderSandbox.root, "package.json");
    const builderPackageBefore = await lstat(builderPackagePath, { bigint: true });
    await expect(builderSandbox.module.buildReleaseCandidate({
      skillRoot: builderSandbox.skillRoot,
      version: builderSandbox.module.RELEASE_VERSION,
      async onSnapshotCheckpoint(phase) {
        if (phase !== "package-bound") return;
        await writeFile(builderPackagePath, driftedPackage);
        const builderPackageAfter = await lstat(builderPackagePath, { bigint: true });
        expect(builderPackageAfter.ino).toBe(builderPackageBefore.ino);
        expect(builderPackageAfter.size).toBe(builderPackageBefore.size);
      },
    })).rejects.toThrow(/package\.json|repository contract/u);
  });

  it("verifies private extraction plus Node 24 help and template-backed render to validate without npm", async () => {
    const release = await releaseModule();
    const verify = await verifyModule();
    await expect(verify.verifyDistribution()).resolves.toEqual(expect.objectContaining({
      version: release.RELEASE_VERSION,
      entryCount: release.SKILL_FILES.length,
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      node: expect.stringMatching(/^\//u),
    }));

    for (const mutation of ["package", "source", "pair"] as const) {
      const sandbox = await releaseSandbox(`terminal-${mutation}`);
      await sandbox.module.writeReleaseCandidate({
        skillRoot: sandbox.skillRoot,
        version: sandbox.module.RELEASE_VERSION,
      });
      let checkpointReached = false;
      await expect(sandbox.verifier.verifyDistribution({
        repositoryRoot: sandbox.root,
        skillRoot: sandbox.skillRoot,
        async onTerminalCheckpoint(checkpoint) {
          expect(checkpoint.phase).toBe("held-sessions-open");
          checkpointReached = true;
          const targetPath = mutation === "package"
            ? checkpoint.packagePath
            : mutation === "source"
              ? join(checkpoint.skillRoot, "SKILL.md")
              : checkpoint.zipPath;
          const before = await lstat(targetPath, { bigint: true });
          const original = await readFile(targetPath);
          let drifted;
          if (mutation === "package") {
            drifted = Buffer.from(
              original.toString("utf8")
                .replace('"version": "0.2.1"', '"version": "0.2.2"')
                .replace('"node": ">=24 <25"', '"node": ">=23 <25"'),
              "utf8",
            );
          } else {
            drifted = Buffer.from(original);
            drifted[40] = (drifted[40] ?? 0) ^ 0xff;
          }
          expect(drifted.equals(original)).toBe(false);
          expect(drifted.byteLength).toBe(original.byteLength);
          await writeFile(targetPath, drifted);
          const after = await lstat(targetPath, { bigint: true });
          expect(after.ino).toBe(before.ino);
          expect(after.size).toBe(before.size);
        },
      })).rejects.toThrow(/package\.json|release source|release ZIP|live release source/u);
      expect(checkpointReached).toBe(true);
    }
  }, 120_000);

  it("bounds hostile child trees, inherited pipes, and output without hanging the release gate", async () => {
    const verify = await verifyModule();
    const root = await temporaryRoot("hostile-child");
    await expect(verify.runSubprocessAdversarialChecks(process.execPath, root, { PATH: "" })).resolves.toBeUndefined();
  });

  it("rejects symlinked source files and a final source parent symlink", async () => {
    const release = await releaseModule();
    const fileRoot = await physicalSkill("symlink-file");
    const source = join(fileRoot, "SKILL.md");
    const replacement = join(fileRoot, "SKILL.real.md");
    await rename(source, replacement);
    await symlink(replacement, source);
    await expect(release.buildReleaseCandidate({ skillRoot: fileRoot })).rejects.toThrow(/regular file|canonical/u);

    const parentRoot = await physicalSkill("symlink-parent");
    const assets = join(parentRoot, "assets");
    const realAssets = join(parentRoot, "assets-real");
    await rename(assets, realAssets);
    await symlink(realAssets, assets);
    await expect(release.buildReleaseCandidate({ skillRoot: parentRoot })).rejects.toThrow(/directory|canonical|symlink/u);
  });

  it("rolls back callback faults and retains tampered manifest evidence at every transaction checkpoint", async () => {
    const sandbox = await releaseSandbox("rollback-checkpoints");
    await sandbox.module.writeReleaseCandidate({ skillRoot: sandbox.skillRoot, version: sandbox.module.RELEASE_VERSION });
    const baseline = await snapshotPair(sandbox);
    const skillPath = join(sandbox.skillRoot, "SKILL.md");
    await writeFile(skillPath, Buffer.concat([await readFile(skillPath), Buffer.from("\nrelease fault fixture\n")]));
    const checkpoints = [
      "staged",
      "backed-up-zip",
      "backed-up-manifest",
      "installed-zip",
      "installed-manifest",
      "verified",
      "before-cleanup",
    ];
    for (const checkpoint of checkpoints) {
      await expect(sandbox.module.writeReleaseCandidate({
        skillRoot: sandbox.skillRoot,
        version: sandbox.module.RELEASE_VERSION,
        onCheckpoint(phase) {
          if (phase === checkpoint) throw new Error(`fault:${checkpoint}`);
        },
      })).rejects.toThrow(`fault:${checkpoint}`);
      const restored = await snapshotPair(sandbox);
      expect(restored.zip.equals(baseline.zip)).toBe(true);
      expect(restored.manifest.equals(baseline.manifest)).toBe(true);
      expect(await pathIsAbsent(join(sandbox.root, sandbox.module.RELEASE_TRANSACTION_DIR))).toBe(true);
    }

    for (const checkpoint of checkpoints) {
      const tamperSandbox = await releaseSandbox(`manifest-tamper-${checkpoint}`);
      await tamperSandbox.module.writeReleaseCandidate({
        skillRoot: tamperSandbox.skillRoot,
        version: tamperSandbox.module.RELEASE_VERSION,
      });
      const tamperSkillPath = join(tamperSandbox.skillRoot, "SKILL.md");
      await writeFile(
        tamperSkillPath,
        Buffer.concat([await readFile(tamperSkillPath), Buffer.from(`\nmanifest tamper ${checkpoint}\n`)]),
      );
      const transactionDirectory = join(tamperSandbox.root, tamperSandbox.module.RELEASE_TRANSACTION_DIR);
      const transactionManifest = join(transactionDirectory, "transaction.json");
      await expect(tamperSandbox.module.writeReleaseCandidate({
        skillRoot: tamperSandbox.skillRoot,
        version: tamperSandbox.module.RELEASE_VERSION,
        async onCheckpoint(phase) {
          if (phase !== checkpoint) return;
          const manifestBefore = await lstat(transactionManifest, { bigint: true });
          const manifestBytes = await readFile(transactionManifest);
          await writeFile(transactionManifest, Buffer.alloc(manifestBytes.byteLength, 0x20));
          const manifestAfter = await lstat(transactionManifest, { bigint: true });
          expect(manifestAfter.ino).toBe(manifestBefore.ino);
          expect(manifestAfter.size).toBe(manifestBefore.size);
        },
      })).rejects.toThrow(/evidence (?:changed unexpectedly|is uncertain|retained)|rollback is uncertain/u);
      expect((await lstat(transactionDirectory)).isDirectory()).toBe(true);
      await expect(tamperSandbox.module.writeReleaseCandidate({
        skillRoot: tamperSandbox.skillRoot,
        version: tamperSandbox.module.RELEASE_VERSION,
      })).rejects.toThrow(/orphaned release transaction/u);
      expect((await lstat(transactionDirectory)).isDirectory()).toBe(true);
    }

    for (const checkpoint of checkpoints) {
      const packageSandbox = await releaseSandbox(`writer-package-${checkpoint}`);
      await packageSandbox.module.writeReleaseCandidate({
        skillRoot: packageSandbox.skillRoot,
        version: packageSandbox.module.RELEASE_VERSION,
      });
      const priorPair = await snapshotPair(packageSandbox);
      const packageSkillPath = join(packageSandbox.skillRoot, "SKILL.md");
      await writeFile(
        packageSkillPath,
        Buffer.concat([await readFile(packageSkillPath), Buffer.from(`\nwriter package ${checkpoint}\n`)]),
      );
      const writerPackagePath = join(packageSandbox.root, "package.json");
      await expect(packageSandbox.module.writeReleaseCandidate({
        skillRoot: packageSandbox.skillRoot,
        version: packageSandbox.module.RELEASE_VERSION,
        async onCheckpoint(phase) {
          if (phase !== checkpoint) return;
          const packageBytes = await readFile(writerPackagePath);
          const driftedBytes = Buffer.from(
            packageBytes.toString("utf8")
              .replace('"version": "0.2.1"', '"version": "0.2.2"')
              .replace('"node": ">=24 <25"', '"node": ">=23 <25"'),
            "utf8",
          );
          expect(driftedBytes.equals(packageBytes)).toBe(false);
          expect(driftedBytes.byteLength).toBe(packageBytes.byteLength);
          const packageBefore = await lstat(writerPackagePath, { bigint: true });
          await writeFile(writerPackagePath, driftedBytes);
          const packageAfter = await lstat(writerPackagePath, { bigint: true });
          expect(packageAfter.ino).toBe(packageBefore.ino);
          expect(packageAfter.size).toBe(packageBefore.size);
        },
      })).rejects.toThrow(/package\.json|repository contract/u);
      const restoredPair = await snapshotPair(packageSandbox);
      expect(restoredPair.zip.equals(priorPair.zip)).toBe(true);
      expect(restoredPair.manifest.equals(priorPair.manifest)).toBe(true);
      expect(await pathIsAbsent(join(packageSandbox.root, packageSandbox.module.RELEASE_TRANSACTION_DIR))).toBe(true);
    }
  }, 120_000);

  it("retains crash evidence and refuses a follow-up run instead of claiming a mismatched pair", async () => {
    const sandbox = await releaseSandbox("crash-refusal");
    const verify = await verifyModule();
    await sandbox.module.writeReleaseCandidate({ skillRoot: sandbox.skillRoot, version: sandbox.module.RELEASE_VERSION });
    const skillPath = join(sandbox.skillRoot, "SKILL.md");
    await writeFile(skillPath, Buffer.concat([await readFile(skillPath), Buffer.from("\ncrash fixture\n")]));
    const moduleUrl = pathToFileURL(join(sandbox.root, "tools", "release-build.mjs")).href;
    const crashDriver = [
      `const release = await import(${JSON.stringify(moduleUrl)});`,
      "await release.writeReleaseCandidate({",
      `  skillRoot: ${JSON.stringify(sandbox.skillRoot)},`,
      `  version: ${JSON.stringify(sandbox.module.RELEASE_VERSION)},`,
      "  onCheckpoint(phase) { if (phase === 'installed-zip') process.exit(86); },",
      "});",
    ].join("\n");
    const crashed = await verify.runBoundedProcess(process.execPath, ["--input-type=module", "-e", crashDriver], {
      cwd: sandbox.root,
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
      timeoutMs: 30_000,
      outputLimitBytes: 64 * 1024,
    });
    expect(crashed).toEqual({ code: 86, signal: null, stdout: "", stderr: "" });
    expect((await lstat(join(sandbox.root, sandbox.module.RELEASE_TRANSACTION_DIR))).isDirectory()).toBe(true);

    const retryDriver = [
      `const release = await import(${JSON.stringify(moduleUrl)});`,
      "try {",
      `  await release.writeReleaseCandidate({ skillRoot: ${JSON.stringify(sandbox.skillRoot)}, version: ${JSON.stringify(sandbox.module.RELEASE_VERSION)} });`,
      "  console.log('unexpected-success');",
      "} catch (error) {",
      "  console.error(error instanceof Error ? error.message : 'release failed');",
      "  process.exitCode = 3;",
      "}",
    ].join("\n");
    const retried = await verify.runBoundedProcess(process.execPath, ["--input-type=module", "-e", retryDriver], {
      cwd: sandbox.root,
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
      timeoutMs: 30_000,
      outputLimitBytes: 64 * 1024,
    });
    expect(retried.code).toBe(3);
    expect(retried.signal).toBe(null);
    expect(retried.stdout).toBe("");
    expect(retried.stderr).toMatch(/orphaned release transaction/u);
    expect(await pathIsAbsent(join(sandbox.root, sandbox.module.RELEASE_MANIFEST_PATH))).toBe(true);
    expect((await lstat(join(sandbox.root, sandbox.module.RELEASE_ZIP_PATH))).isFile()).toBe(true);
  }, 60_000);
});
