import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeliveryHandoff } from "../../src/cli/validate.js";
import {
  prepareValidatedFixture,
  syntheticReplyFixture,
  UNCERTAINTY_KEYS,
  verifyFinalReplyFixture,
} from "./final-handoff.helpers.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), `dar-final-${label}-`)));
  await chmod(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}

async function createFreshEvidenceRoot(path: string): Promise<string> {
  const parent = dirname(path);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || (parentMetadata.mode & 0o777) !== 0o700) {
    throw new Error("fresh evidence parent must be a real private 0700 directory");
  }
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return realpath(path);
}

async function readPrivateEvidenceFile(root: string, name: string): Promise<string> {
  const path = join(root, name);
  const metadata = await lstat(path);
  const currentUser = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0
    || (currentUser !== undefined && metadata.uid !== currentUser)) {
    throw new Error(`${name} must be a real private file`);
  }
  const canonicalPath = await realpath(path);
  if (canonicalPath !== root && !canonicalPath.startsWith(`${root}${sep}`)) {
    throw new Error(`${name} escapes the evidence root`);
  }
  if (relative(root, canonicalPath) !== name) throw new Error(`${name} is not canonical`);
  return readFile(canonicalPath, "utf8");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    rm(path, { recursive: true, force: true })));
});

describe("synthetic final-reply verifier fixtures", () => {
  it.each([
    ["evidence-gaps", ["evidenceGaps"]],
    ["nonblocking-conflicts", ["unresolvedNonblockingConflicts"]],
    ["risks", ["risks"]],
    ["open-questions", ["openQuestions"]],
    ["all-four", [...UNCERTAINTY_KEYS]],
  ] as const)("accepts %s with exact links, identity, asOf, and separate uncertainty disclosure", async (label, categories) => {
    const root = await temporaryDirectory(label);
    const fixture = await prepareValidatedFixture(root, label, categories);
    await expect(verifyFinalReplyFixture(
      syntheticReplyFixture(fixture.root, fixture.handoff),
      fixture.root,
      fixture.handoff,
    )).resolves.toBeUndefined();
  });

  it("accepts the natural combined-identity and inline-summary format used by the fresh capture", async () => {
    const root = await temporaryDirectory("natural-format");
    const fixture = await prepareValidatedFixture(root, "natural_format", UNCERTAINTY_KEYS);
    const handoff = fixture.handoff;
    const reply = [
      `Document \`${handoff.documentId}\` — content version \`${handoff.contentVersion}\`, round \`${handoff.round}\`, as of \`${handoff.asOf}\`.`,
      "",
      `[Agent Markdown](${join(root, handoff.artifacts.agent.relativePath)})`,
      `[Approval HTML](${join(root, handoff.artifacts.approval.relativePath)})`,
      "",
      ...UNCERTAINTY_KEYS.map((key) => {
        const uncertainty = handoff.uncertainties[key];
        return `- \`${key}\` — ${uncertainty.count}: ${uncertainty.safeSummaries.join(" ")}`;
      }),
      "",
    ].join("\n");
    await expect(verifyFinalReplyFixture(reply, root, handoff)).resolves.toBeUndefined();
  });

  it("rejects missing, duplicate, extra, merged, escaped, and stale synthetic replies", async () => {
    const root = await temporaryDirectory("negative");
    const fixture = await prepareValidatedFixture(root, "negative", UNCERTAINTY_KEYS);
    const valid = syntheticReplyFixture(fixture.root, fixture.handoff);
    const agentLine = `[Agent continuation file](${join(fixture.root, fixture.handoff.artifacts.agent.relativePath)})`;
    const approvalLine = `[Approval decision workspace](${join(fixture.root, fixture.handoff.artifacts.approval.relativePath)})`;
    const firstRisk = fixture.handoff.uncertainties.risks.safeSummaries[0]!;
    const mergedCategoryLine = UNCERTAINTY_KEYS.map((key) =>
      `${key} (${fixture.handoff.uncertainties[key].count})`).join("; ");
    const mergedCategories = valid
      .replace(`evidenceGaps (${fixture.handoff.uncertainties.evidenceGaps.count})`, mergedCategoryLine)
      .replace(`\nunresolvedNonblockingConflicts (${fixture.handoff.uncertainties.unresolvedNonblockingConflicts.count})`, "")
      .replace(`\nrisks (${fixture.handoff.uncertainties.risks.count})`, "")
      .replace(`\nopenQuestions (${fixture.handoff.uncertainties.openQuestions.count})`, "");
    const failures = [
      valid.replace(`${approvalLine}\n`, ""),
      valid.replace(approvalLine, `${approvalLine}\n${approvalLine}`),
      `${valid}[Extra](${join(fixture.root, "review-document.json")})\n`,
      valid.replace(`risks (${fixture.handoff.uncertainties.risks.count})`, "risks"),
      valid.replace(`Summary: ${firstRisk}\n`, ""),
      valid.replace(agentLine, "[Agent](/etc/hosts)"),
      valid.replace(fixture.handoff.documentId, "RD-AAAAAAAAAAAAAAAAAAAA"),
      valid.replace(`Round: \`${fixture.handoff.round}\`\n`, ""),
      `${valid}Document: \`${fixture.handoff.documentId}\`\n`,
      `${valid}Document: \`RD-AAAAAAAAAAAAAAAAAAAA\`\n`,
      valid.replace(
        `Document: \`${fixture.handoff.documentId}\``,
        `Document: \`${fixture.handoff.documentId}\`; Document: \`${fixture.handoff.documentId}\``,
      ),
      valid.replace(
        `Document: \`${fixture.handoff.documentId}\``,
        `Document: \`${fixture.handoff.documentId}\`; Document: \`RD-AAAAAAAAAAAAAAAAAAAA\``,
      ),
      valid.replace(
        `Document: \`${fixture.handoff.documentId}\``,
        `Document: \`RD-AAAAAAAAAAAAAAAAAAAA\` superseded by \`${fixture.handoff.documentId}\``,
      ),
      valid.replace(`Content version: \`${fixture.handoff.contentVersion}\``, "Content version: `999`"),
      valid.replace(
        `Content version: \`${fixture.handoff.contentVersion}\``,
        `Content version: \`999 / ${fixture.handoff.contentVersion}\``,
      ),
      valid.replace(`Round: \`${fixture.handoff.round}\``, `Round: \`999 / ${fixture.handoff.round}\``),
      valid.replace(`As of: \`${fixture.handoff.asOf}\``, "As of: `2026-08-13T09:00:00Z`"),
      valid.replace(
        `As of: \`${fixture.handoff.asOf}\``,
        `As of: \`2026-08-13T09:00:00Z / ${fixture.handoff.asOf}\``,
      ),
      valid.replace(
        `risks (${fixture.handoff.uncertainties.risks.count})`,
        `risks — 999 (${fixture.handoff.uncertainties.risks.count})`,
      ),
      valid.replace(
        `risks (${fixture.handoff.uncertainties.risks.count})`,
        `risks — ${fixture.handoff.uncertainties.risks.count} / 999`,
      ),
      mergedCategories,
    ];
    for (const reply of failures) {
      await expect(verifyFinalReplyFixture(reply, fixture.root, fixture.handoff)).rejects.toThrow();
    }
  });

  it("rejects permissive or symlinked external capture files before reading them", async () => {
    const root = await temporaryDirectory("capture-boundary");
    const permissive = join(root, "permissive.json");
    await writeFile(permissive, "{}\n", { mode: 0o600 });
    await chmod(permissive, 0o644);
    await expect(readPrivateEvidenceFile(root, "permissive.json")).rejects.toThrow(
      "must be a real private file",
    );

    const privateTarget = join(root, "private-target.json");
    await writeFile(privateTarget, "{}\n", { mode: 0o600 });
    await chmod(privateTarget, 0o600);
    await symlink(privateTarget, join(root, "capture-link.json"));
    await expect(readPrivateEvidenceFile(root, "capture-link.json")).rejects.toThrow(
      "must be a real private file",
    );
  });

  it.skipIf(process.env.DAR_PREPARE_FRESH_EVIDENCE_ROOT === undefined)(
    "prepares real all-four artifacts and handoff for a later external fresh Agent run",
    async () => {
      const requested = process.env.DAR_PREPARE_FRESH_EVIDENCE_ROOT;
      if (requested === undefined) throw new Error("DAR_PREPARE_FRESH_EVIDENCE_ROOT is required");
      const root = await createFreshEvidenceRoot(requested);
      const fixture = await prepareValidatedFixture(root, "fresh", UNCERTAINTY_KEYS);
      await writeFile(join(root, "handoff.json"), `${JSON.stringify(fixture.handoff, null, 2)}\n`, { mode: 0o600 });
      await chmod(join(root, "handoff.json"), 0o600);
    },
  );

  it.skipIf(process.env.DAR_FRESH_EVIDENCE_ROOT === undefined)(
    "verifies an externally captured fresh Agent final reply without embedding expected reply text",
    async () => {
      const requested = process.env.DAR_FRESH_EVIDENCE_ROOT;
      if (requested === undefined) throw new Error("DAR_FRESH_EVIDENCE_ROOT is required");
      const rootMetadata = await lstat(requested);
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o077) !== 0) {
        throw new Error("fresh evidence root must be a real private directory");
      }
      const root = await realpath(requested);
      const handoff = JSON.parse(await readPrivateEvidenceFile(root, "handoff.json")) as DeliveryHandoff;
      const reply = await readPrivateEvidenceFile(root, "fresh-final-reply.md");
      await verifyFinalReplyFixture(reply, root, handoff);
    },
  );
});
