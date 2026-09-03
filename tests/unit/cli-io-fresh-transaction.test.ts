import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitFileTransaction,
  commitFreshFileTransaction,
  resolveOutputRoot,
  validateRelativeTarget,
  type FileTransactionTarget,
  type ResolvedOutputRoot,
  type ValidatedRelativeTarget,
} from "../../src/cli/io/index.js";
import {
  nativeFileSystemAdapter,
  type PrivateFileSystemAdapter,
} from "../../src/cli/io/fsync.js";
import {
  commitFileTransactionWithAdapter,
  commitFreshFileTransactionWithAdapter,
} from "../../src/cli/io/transaction.js";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dar-fresh-transaction-unit-")));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

function target(relativePath: string): ValidatedRelativeTarget {
  const result = validateRelativeTarget(relativePath);
  if (!result.ok) throw new Error("target setup failed");
  return result.value;
}

function createTarget(relativePath = "artifact.txt", text = "new"): FileTransactionTarget {
  return {
    target: target(relativePath),
    bytes: encoder.encode(text),
    disposition: "create",
    verifyStaged: () => ({ ok: true }),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT";
  }
}

async function resolvedRoot(output: string): Promise<ResolvedOutputRoot> {
  const resolved = await resolveOutputRoot({
    outputDir: output,
    creation: "create-if-missing",
    freshness: "require-no-business-entries",
  });
  if (!resolved.ok) throw new Error("root setup failed");
  return resolved.value;
}

function trapGuard<T extends object>(value: T): { proxy: T; trapCalls: () => number } {
  let calls = 0;
  const trapped = (): never => {
    calls += 1;
    throw new Error("proxy trap must not run");
  };
  const proxy = new Proxy(value, {
    apply: trapped,
    construct: trapped,
    defineProperty: trapped,
    deleteProperty: trapped,
    get: trapped,
    getOwnPropertyDescriptor: trapped,
    getPrototypeOf: trapped,
    has: trapped,
    isExtensible: trapped,
    ownKeys: trapped,
    preventExtensions: trapped,
    set: trapped,
    setPrototypeOf: trapped,
  });
  return { proxy, trapCalls: () => calls };
}

type FreshInput = Parameters<typeof commitFreshFileTransaction>[0];

function validFreshInput(outputDir: string): FreshInput {
  return {
    outputDir,
    generatorVersion: "0.2.1",
    targets: [createTarget()],
  };
}

async function recoveryScene(output: string): Promise<{ container: string; witness: string }> {
  const container = join(output, ".review-txn");
  const witness = join(container, "TXN-00000000000000000000");
  await mkdir(output, { mode: 0o700 });
  await mkdir(container, { mode: 0o700 });
  await mkdir(witness, { mode: 0o700 });
  await writeFile(join(output, "business.txt"), "existing", { mode: 0o600 });
  return { container, witness };
}

function countingFaultAdapter(
  checkpoint: PrivateFileSystemAdapter["checkpoint"],
): { adapter: PrivateFileSystemAdapter; writeCalls: () => number } {
  let writes = 0;
  return {
    adapter: {
      ...nativeFileSystemAdapter,
      checkpoint,
      open: async (...args: Parameters<PrivateFileSystemAdapter["open"]>) => {
        writes += 1;
        return nativeFileSystemAdapter.open(...args);
      },
      link: async (...args: Parameters<PrivateFileSystemAdapter["link"]>) => {
        writes += 1;
        await nativeFileSystemAdapter.link(...args);
      },
      mkdir: async (...args: Parameters<PrivateFileSystemAdapter["mkdir"]>) => {
        writes += 1;
        await nativeFileSystemAdapter.mkdir(...args);
      },
      rename: async (...args: Parameters<PrivateFileSystemAdapter["rename"]>) => {
        writes += 1;
        await nativeFileSystemAdapter.rename(...args);
      },
      unlink: async (...args: Parameters<PrivateFileSystemAdapter["unlink"]>) => {
        writes += 1;
        await nativeFileSystemAdapter.unlink(...args);
      },
      rmdir: async (...args: Parameters<PrivateFileSystemAdapter["rmdir"]>) => {
        writes += 1;
        await nativeFileSystemAdapter.rmdir(...args);
      },
    },
    writeCalls: () => writes,
  };
}

describe("fresh file transaction preflight", () => {
  it.each([
    {
      name: "outer record",
      make: (input: FreshInput) => trapGuard(input),
      expectedPath: "/outputDir",
    },
    {
      name: "target array",
      make: (input: FreshInput) => {
        const guarded = trapGuard(input.targets as FileTransactionTarget[]);
        return { ...guarded, proxy: { ...input, targets: guarded.proxy } as FreshInput };
      },
      expectedPath: "/targets",
    },
    {
      name: "target record",
      make: (input: FreshInput) => {
        const guarded = trapGuard(input.targets[0] as FileTransactionTarget);
        return { ...guarded, proxy: { ...input, targets: [guarded.proxy] } as FreshInput };
      },
      expectedPath: "/targets/0",
    },
    {
      name: "owned bytes",
      make: (input: FreshInput) => {
        const guarded = trapGuard(input.targets[0]?.bytes as Uint8Array);
        return {
          ...guarded,
          proxy: {
            ...input,
            targets: [{ ...input.targets[0] as FileTransactionTarget, bytes: guarded.proxy }],
          } as FreshInput,
        };
      },
      expectedPath: "/targets/0",
    },
    {
      name: "staged verifier",
      make: (input: FreshInput) => {
        const guarded = trapGuard(input.targets[0]?.verifyStaged as FileTransactionTarget["verifyStaged"]);
        return {
          ...guarded,
          proxy: {
            ...input,
            targets: [{ ...input.targets[0] as FileTransactionTarget, verifyStaged: guarded.proxy }],
          } as FreshInput,
        };
      },
      expectedPath: "/targets/0",
    },
  ])("rejects a hostile Proxy at the $name boundary without traps or filesystem access", async ({
    make,
    expectedPath,
  }) => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const guarded = make(validFreshInput(output));
    let adapterReads = 0;
    const adapter = new Proxy(nativeFileSystemAdapter, {
      get: (targetAdapter, key, receiver) => {
        adapterReads += 1;
        return Reflect.get(targetAdapter, key, receiver) as unknown;
      },
    });

    const seamResult = await commitFreshFileTransactionWithAdapter(guarded.proxy, adapter);
    expect(seamResult).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ path: expectedPath }],
    });
    expect(adapterReads).toBe(0);
    expect(guarded.trapCalls()).toBe(0);

    const publicResult = await commitFreshFileTransaction(guarded.proxy);
    expect(publicResult).toMatchObject({ ok: false, mutated: false, recoveryRequired: false });
    expect(guarded.trapCalls()).toBe(0);
    expect(await pathExists(output)).toBe(false);
  });

  it("rejects revoked Proxies and accessors without invoking user code or touching the adapter", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const revoked = Proxy.revocable(validFreshInput(output), {});
    revoked.revoke();
    let getterCalls = 0;
    const getterInput = Object.defineProperties({}, {
      outputDir: { enumerable: true, get: () => { getterCalls += 1; return output; } },
      generatorVersion: { enumerable: true, value: "0.2.1" },
      targets: { enumerable: true, value: [createTarget()] },
    }) as FreshInput;
    let adapterReads = 0;
    const adapter = new Proxy(nativeFileSystemAdapter, {
      get: (targetAdapter, key, receiver) => {
        adapterReads += 1;
        return Reflect.get(targetAdapter, key, receiver) as unknown;
      },
    });

    await expect(commitFreshFileTransaction(revoked.proxy)).resolves.toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
    });
    expect(await commitFreshFileTransactionWithAdapter(getterInput, adapter)).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ path: "/outputDir" }],
    });
    expect(getterCalls).toBe(0);
    expect(adapterReads).toBe(0);
    expect(await pathExists(output)).toBe(false);
  });

  it("runs the first staged verifier before any output-root filesystem access", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const result = await commitFreshFileTransaction({
      outputDir: output,
      generatorVersion: "0.2.1",
      targets: [{
        ...createTarget(),
        verifyStaged: () => ({ ok: false }),
      }],
    });
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "STAGED_CONTENT_INVALID", path: "/targets/0/bytes" }],
    });
    expect(await pathExists(output)).toBe(false);
  });

  it("binds a relative output path before a staged verifier can change the working directory", async () => {
    const originalCwd = process.cwd();
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    const expectedOutput = join(first, "output");
    const redirectedOutput = join(second, "output");
    let verifierCalls = 0;
    try {
      process.chdir(first);
      const result = await commitFreshFileTransaction({
        outputDir: "output",
        generatorVersion: "0.2.1",
        targets: [{
          ...createTarget(),
          verifyStaged: () => {
            verifierCalls += 1;
            if (verifierCalls === 1) process.chdir(second);
            return { ok: true };
          },
        }],
      });
      expect(result).toMatchObject({ ok: true });
      expect(await readFile(join(expectedOutput, "artifact.txt"), "utf8")).toBe("new");
      expect(await pathExists(redirectedOutput)).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("keeps an absent relative root bound when the working directory changes after the probe", async () => {
    const originalCwd = process.cwd();
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    const expectedOutput = join(first, "output");
    const redirectedOutput = join(second, "output");
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (point === "fresh-output-probed:fresh") process.chdir(second);
      },
    };
    try {
      process.chdir(first);
      const result = await commitFreshFileTransactionWithAdapter({
        outputDir: "output",
        generatorVersion: "0.2.1",
        targets: [createTarget()],
      }, adapter);
      expect(result).toMatchObject({ ok: true });
      expect(await readFile(join(expectedOutput, "artifact.txt"), "utf8")).toBe("new");
      expect(await pathExists(redirectedOutput)).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects portable collisions before an absent output root appears", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const result = await commitFreshFileTransaction({
      outputDir: output,
      generatorVersion: "0.2.1",
      targets: [createTarget("Straße.txt"), createTarget("STRASSE.txt")],
    });
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "PORTABLE_PATH_COLLISION" }],
    });
    expect(await pathExists(output)).toBe(false);
  });

  it("does not change an ordinary nonempty root or create a transaction container", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    await mkdir(output, { mode: 0o700 });
    await writeFile(join(output, "existing.txt"), "existing", { mode: 0o600 });
    await chmod(join(output, "existing.txt"), 0o600);
    const before = await stat(output);

    const result = await commitFreshFileTransaction({
      outputDir: output,
      generatorVersion: "0.2.1",
      targets: [createTarget()],
    });

    expect(result).toEqual({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [expect.objectContaining({ code: "PATH_INVALID", path: "/outputDir" })],
    });
    const after = await stat(output);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(output)).toEqual(["existing.txt"]);
    expect(await pathExists(join(output, ".review-txn"))).toBe(false);
  });

  it.each(["removed", "replaced"] as const)(
    "rejects a recovery container that is %s after the read-only probe without rebuilding it",
    async (mode) => {
      const parent = await temporaryDirectory();
      const output = join(parent, "output");
      const { container } = await recoveryScene(output);
      let injectedRootMtime: number | undefined;
      const counted = countingFaultAdapter(async (point) => {
        if (point !== "fresh-output-probed:recovery") return;
        await rm(container, { recursive: true, force: true });
        if (mode === "replaced") await mkdir(container, { mode: 0o700 });
        injectedRootMtime = (await stat(output)).mtimeMs;
      });

      const result = await commitFreshFileTransactionWithAdapter(validFreshInput(output), counted.adapter);
      expect(result).toMatchObject({
        ok: false,
        mutated: false,
        recoveryRequired: false,
        errors: [{ code: "PATH_INVALID", path: "/outputDir" }],
      });
      expect(counted.writeCalls()).toBe(0);
      expect((await stat(output)).mtimeMs).toBe(injectedRootMtime);
      expect(await readFile(join(output, "business.txt"), "utf8")).toBe("existing");
      expect(await pathExists(container)).toBe(mode === "replaced");
      if (mode === "replaced") expect(await readdir(container)).toEqual([]);
    },
  );

  it("rechecks the bound recovery witness immediately before the first claim write", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const { container, witness } = await recoveryScene(output);
    let injectedContainerMtime: number | undefined;
    const counted = countingFaultAdapter(async (point) => {
      if (point !== "fresh-recovery-root-resolved") return;
      await rm(witness, { recursive: true, force: true });
      injectedContainerMtime = (await stat(container)).mtimeMs;
    });

    const result = await commitFreshFileTransactionWithAdapter(validFreshInput(output), counted.adapter);
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "PATH_INVALID", path: "/outputDir" }],
    });
    expect(counted.writeCalls()).toBe(0);
    expect((await stat(container)).mtimeMs).toBe(injectedContainerMtime);
    expect(await readdir(container)).toEqual([]);
    expect(await readFile(join(output, "business.txt"), "utf8")).toBe("existing");
  });

  it.each(["EIO", "EACCES"])(
    "reports %s while checking the recovery witness as uncertain without a candidate write",
    async (code) => {
      const parent = await temporaryDirectory();
      const output = join(parent, "output");
      const { container, witness } = await recoveryScene(output);
      let guardActive = false;
      const counted = countingFaultAdapter(async (point) => {
        if (point === "fresh-recovery-root-resolved") guardActive = true;
      });
      const adapter: PrivateFileSystemAdapter = {
        ...counted.adapter,
        lstat: async (path) => {
          if (guardActive && path === witness) {
            throw Object.assign(new Error("injected recovery witness read fault"), { code });
          }
          return nativeFileSystemAdapter.lstat(path);
        },
      };

      const result = await commitFreshFileTransactionWithAdapter(validFreshInput(output), adapter);
      expect(result).toMatchObject({
        ok: false,
        mutated: true,
        recoveryRequired: true,
        errors: [{ code: "TRANSACTION_RECOVERY_BLOCKED", path: "/writerClaim" }],
      });
      expect(counted.writeCalls()).toBe(0);
      expect(await pathExists(witness)).toBe(true);
      expect(await readdir(container)).toEqual(["TXN-00000000000000000000"]);
      expect(await readFile(join(output, "business.txt"), "utf8")).toBe("existing");
    },
  );

  it("maps a recovery seam checkpoint exception to a stable non-throwing result", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    await recoveryScene(output);
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (point === "fresh-recovery-root-resolved") throw new Error("injected checkpoint failure");
      },
    };
    await expect(commitFreshFileTransactionWithAdapter(validFreshInput(output), adapter)).resolves.toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/writerClaim" }],
    });
  });

  it("commits into a newly created private root and leaves only an empty private container", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const result = await commitFreshFileTransaction({
      outputDir: output,
      generatorVersion: "0.2.1",
      targets: [createTarget()],
    });
    expect(result).toMatchObject({
      ok: true,
      value: { targets: [{ relativePath: "artifact.txt", disposition: "create" }] },
    });
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    expect((await stat(join(output, "artifact.txt"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("new");
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it("removes a root created by this call after a normal pre-manifest failure", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const result = await commitFreshFileTransaction({
      outputDir: output,
      generatorVersion: "0.2.1",
      targets: [createTarget("missing-parent/artifact.txt")],
    });
    expect(result).toMatchObject({ ok: false, mutated: false, recoveryRequired: false });
    expect(await pathExists(output)).toBe(false);
  });

  it("upgrades an uncertain new-root cleanup to a recovery-required failure", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      rmdir: async (path) => {
        if (path === join(output, ".review-txn")) throw new Error("injected cleanup fault");
        await nativeFileSystemAdapter.rmdir(path);
      },
    };
    const result = await commitFreshFileTransactionWithAdapter({
      outputDir: output,
      generatorVersion: "0.2.1",
      targets: [createTarget("missing-parent/artifact.txt")],
    }, adapter);
    expect(result).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_RECOVERY_BLOCKED", path: "/root" }],
    });
    expect(await pathExists(output)).toBe(true);
  });

  it("rechecks freshness after target-parent preflight and before creating a transaction directory", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    await mkdir(output, { mode: 0o700 });
    let rootReads = 0;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      readdir: async (path) => {
        if (path === output) {
          rootReads += 1;
          if (rootReads === 4) {
            await writeFile(join(output, "raced.txt"), "raced", { mode: 0o600 });
            await chmod(join(output, "raced.txt"), 0o600);
          }
        }
        return nativeFileSystemAdapter.readdir(path);
      },
    };
    const result = await commitFreshFileTransactionWithAdapter({
      outputDir: output,
      generatorVersion: "0.2.1",
      targets: [createTarget()],
    }, adapter);
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "PATH_INVALID", path: "/outputDir" }],
    });
    expect(await readFile(join(output, "raced.txt"), "utf8")).toBe("raced");
    expect((await readdir(join(output, ".review-txn"))).filter((name) => name.startsWith("TXN-"))).toEqual([]);
  });
});

describe("ordinary transaction compatibility", () => {
  it("continues accepting benign outer, target-array, target-record, verifier, and verifier-result Proxies", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const root = await resolvedRoot(output);
    const verifierResult = new Proxy({ ok: true as const }, {});
    const verifier = new Proxy(() => verifierResult, {});
    const record = new Proxy({
      ...createTarget(),
      verifyStaged: verifier,
    }, {});
    const targets = new Proxy([record], {});
    const input = new Proxy({
      root,
      generatorVersion: "0.2.1",
      targets,
    }, {});

    const result = await commitFileTransaction(input);

    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("new");
  });

  it("continues accepting an Array subclass whose target is supplied by an inherited index accessor", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const root = await resolvedRoot(output);
    const record = createTarget();
    let indexReads = 0;
    class CompatibleTargets extends Array<FileTransactionTarget> {}
    Object.defineProperty(CompatibleTargets.prototype, "0", {
      configurable: true,
      get: () => {
        indexReads += 1;
        return record;
      },
    });
    const targets = new CompatibleTargets();
    targets.length = 1;

    const result = await commitFileTransaction({ root, generatorVersion: "0.2.1", targets });

    expect(result).toMatchObject({ ok: true });
    expect(indexReads).toBe(1);
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("new");
  });

  it("continues accepting a frozen readonly array, an extra envelope key, and create verifyExisting undefined", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const root = await resolvedRoot(output);
    const file = Object.freeze({
      ...createTarget(),
      verifyExisting: undefined,
    });
    const targets = Object.freeze([file]);
    const result = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets,
      compatibilityExtra: true,
    } as unknown as Parameters<typeof commitFileTransaction>[0]);
    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("new");
  });

  it("keeps root failure ahead of target validation and does not call the staged verifier", async () => {
    let verifierCalls = 0;
    const result = await commitFileTransactionWithAdapter({
      root: Object.freeze({}) as ResolvedOutputRoot,
      generatorVersion: "0.2.1",
      targets: [{
        ...createTarget(),
        verifyStaged: () => {
          verifierCalls += 1;
          return { ok: false };
        },
      }],
    }, nativeFileSystemAdapter);
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "PATH_INVALID", path: "/root" }],
    });
    expect(verifierCalls).toBe(0);
  });

  it("rebinds the ordinary root after recovery before snapshotting or invoking a staged verifier", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const root = await resolvedRoot(output);
    let verifierCalls = 0;
    let failNextRootRead = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (point === "transaction-recovery-complete") failNextRootRead = true;
      },
      lstat: async (path) => {
        if (path === output && failNextRootRead) {
          failNextRootRead = false;
          throw Object.assign(new Error("injected root rebind failure"), { code: "EIO" });
        }
        return nativeFileSystemAdapter.lstat(path);
      },
    };
    let targetsGetterCalls = 0;
    const input = Object.defineProperties({}, {
      root: { enumerable: true, value: root },
      generatorVersion: { enumerable: true, value: "0.2.1" },
      targets: {
        enumerable: true,
        get: () => {
          targetsGetterCalls += 1;
          return [{
            ...createTarget(),
            verifyStaged: () => {
              verifierCalls += 1;
              return { ok: true };
            },
          }];
        },
      },
    }) as Parameters<typeof commitFileTransactionWithAdapter>[0];
    const result = await commitFileTransactionWithAdapter(input, adapter);
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/transaction" }],
    });
    expect(targetsGetterCalls).toBe(0);
    expect(verifierCalls).toBe(0);
  });

  it("keeps the first ordinary staged verifier inside the acquired writer claim", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const root = await resolvedRoot(output);
    const claimObservations: boolean[] = [];
    const result = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        ...createTarget(),
        verifyStaged: async () => {
          claimObservations.push(await pathExists(join(output, ".review-txn", ".writer-claim")));
          return { ok: true };
        },
      }],
    });
    expect(result).toMatchObject({ ok: true });
    expect(claimObservations).toEqual([true, true, true]);
  });

  it("keeps ordinary targets getter and array-index accessor exception paths", async () => {
    const parent = await temporaryDirectory();
    for (const boundary of ["targets", "index"] as const) {
      const output = join(parent, boundary);
      const root = await resolvedRoot(output);
      const targets = [createTarget()];
      if (boundary === "index") {
        Object.defineProperty(targets, "0", {
          enumerable: true,
          get: () => { throw new Error("hostile target index getter"); },
        });
      }
      const input = boundary === "targets"
        ? Object.defineProperties({}, {
            root: { enumerable: true, value: root },
            generatorVersion: { enumerable: true, value: "0.2.1" },
            targets: { enumerable: true, get: () => { throw new Error("hostile targets getter"); } },
          })
        : { root, generatorVersion: "0.2.1", targets };
      const result = await commitFileTransactionWithAdapter(
        input as Parameters<typeof commitFileTransactionWithAdapter>[0],
        nativeFileSystemAdapter,
      );
      expect(result).toMatchObject({
        ok: false,
        mutated: false,
        recoveryRequired: false,
        errors: [{
          code: "IO_OPERATION_FAILED",
          path: boundary === "targets" ? "/transaction" : "/targets",
        }],
      });
    }
  });

  it("preserves ordinary transparent proxies, accessor indices, subclasses, and verifier results", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const root = await resolvedRoot(output);
    const verifier = new Proxy(
      (() => new Proxy({ ok: true as const }, {})),
      {},
    );
    const targetPlan = new Proxy({
      ...createTarget(),
      verifyStaged: verifier,
    }, {});
    class CompatibleTargets extends Array<FileTransactionTarget> {}
    const targets = new CompatibleTargets(1);
    Object.defineProperty(targets, "0", {
      configurable: true,
      enumerable: false,
      get: () => targetPlan,
    });
    const input = new Proxy({
      root,
      generatorVersion: "0.2.1",
      targets,
    }, {});

    const result = await commitFileTransactionWithAdapter(input, nativeFileSystemAdapter);
    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("new");
  });
});
