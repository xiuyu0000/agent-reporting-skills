import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface WorkflowFixture {
  readonly verificationScope: string;
  readonly expectedStageOrder: readonly string[];
  readonly requiredCommands: Readonly<Record<string, string>>;
  readonly cases: readonly Readonly<Record<string, unknown>>[];
}

const skillRoot = resolve("skills/deliver-dual-audience-report");
const skillPath = resolve(skillRoot, "SKILL.md");
const protocolPath = resolve(skillRoot, "references/review-protocols.md");
const audiencePath = resolve(skillRoot, "references/audience-contracts.md");
const evidencePath = resolve(skillRoot, "references/evidence-and-privacy.md");
const agentTemplatePath = resolve(skillRoot, "assets/agent-context.template.md");
const fixturePath = resolve("tests/fixtures/skill-workflow/cases.json");

const expectedFrontmatter = `---
name: deliver-dual-audience-report
description: "Deliver one verified plan as precise Agent-facing Markdown for continuation and a self-contained interactive Approval HTML for decision and feedback. Use only when one primary human reviewer has an explicit approval, review, or item-by-item feedback goal and the initial proposal naturally contains at least 4 independently decidable items; the same contract continues through later revision rounds. Do not use for fewer than 4 natural decision items, multiple or parallel reviewers, exploratory reading without approval, a single Markdown or HTML report, a chat-only answer, code-only work without a separate plan approval deliverable, or the legacy static Agent report plus human narrative HTML workflow. Never split or pad content merely to reach 4 items."
compatibility: "Requires Node.js on PATH to run scripts/review-delivery.mjs; the validated contract runtime is Node 24 LTS (>=24 <25). No npm install, node_modules, or network access is needed at runtime, and generated artifacts are self-contained offline HTML/Markdown."
---
`;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function bodyOf(skill: string): string {
  expect(skill.startsWith(expectedFrontmatter)).toBe(true);
  return skill.slice(expectedFrontmatter.length).replace(/^\n/u, "");
}

function lineCount(value: string): number {
  return value.split("\n").length;
}

function localMarkdownTargets(value: string): string[] {
  return [...value.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .map((match) => match[1] ?? "")
    .filter((target) => !target.startsWith("#") && !target.includes(":"));
}

function markdownHeadingAnchors(value: string): Set<string> {
  return new Set(
    [...value.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) =>
      (match[1] ?? "")
        .toLocaleLowerCase("en")
        .replace(/[`*_]/gu, "")
        .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
        .trim()
        .replace(/\s+/gu, "-"),
    ),
  );
}

async function loadFixture(): Promise<WorkflowFixture> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as WorkflowFixture;
}

function getCase(
  fixture: WorkflowFixture,
  id: string,
): Readonly<Record<string, unknown>> {
  const candidate = fixture.cases.find((entry) => entry.id === id);
  expect(candidate, `Expected workflow fixture ${id}`).toBeDefined();
  return candidate as Readonly<Record<string, unknown>>;
}

describe("SKL-002 Skill workflow surface", () => {
  it("keeps the SKL-001 frontmatter byte-identical and the body concise", async () => {
    const skill = await readFile(skillPath, "utf8");
    const body = bodyOf(skill);

    expect(skill.slice(0, expectedFrontmatter.length)).toBe(expectedFrontmatter);
    expect(lineCount(body)).toBeLessThan(500);
    expect(body).toMatch(/^# Deliver Dual-Audience Report\n\nCreate /u);
    expect(body).not.toMatch(/^## When to (?:use|trigger)/imu);
  });

  it("links every field reference directly and keeps reference traversal one level deep", async () => {
    const skill = await readFile(skillPath, "utf8");
    const body = bodyOf(skill);
    const references = await Promise.all([
      readFile(protocolPath, "utf8"),
      readFile(audiencePath, "utf8"),
      readFile(evidencePath, "utf8"),
    ]);
    const expectedDirectTargets = [
      "references/review-protocols.md",
      "references/audience-contracts.md",
      "references/evidence-and-privacy.md",
      "references/review-document.schema.json",
      "references/review-packet.schema.json",
      "references/review-state.schema.json",
    ];

    for (const target of expectedDirectTargets) {
      expect(localMarkdownTargets(body), target).toContain(target);
      await expect(readFile(resolve(skillRoot, target), "utf8")).resolves.not.toBe("");
    }
    for (const reference of references) {
      expect(localMarkdownTargets(reference)).toEqual([]);
      if (lineCount(reference) > 100) {
        expect(reference).toMatch(/^## Contents$/mu);
      }
      const headingAnchors = markdownHeadingAnchors(reference);
      const internalTargets = [...reference.matchAll(/\]\(#([^)]+)\)/gu)].map(
        (match) => match[1] ?? "",
      );
      for (const target of internalTargets) {
        expect(headingAnchors, target).toContain(target);
      }
    }
  });

  it("removes legacy public-path guidance from the new body and references", async () => {
    const skill = await readFile(skillPath, "utf8");
    const corpus = [
      bodyOf(skill),
      await readFile(protocolPath, "utf8"),
      await readFile(audiencePath, "utf8"),
      await readFile(evidencePath, "utf8"),
    ].join("\n");
    const oldPaths = [
      ["scripts", "init_delivery.py"].join("/"),
      ["scripts", "validate_delivery.py"].join("/"),
      ["scripts", "record_usage.py"].join("/"),
      ["references", "report-contract.schema.json"].join("/"),
      ["assets", "agent-report.template.md"].join("/"),
      ["assets", "human-report.template.html"].join("/"),
      ["_", "HUMAN.html"].join(""),
    ];

    for (const oldPath of oldPaths) {
      expect(corpus, oldPath).not.toContain(oldPath);
    }
    expect(corpus).not.toContain(["Info", "ORG"].join("_"));
    expect(corpus).not.toMatch(/\bpython3?\b/iu);
    expect(corpus).toContain("dual-audience-report-contract-v1");
    expect(corpus).toMatch(/Reject .*incompatible/isu);
  });

  it("preserves the required init-to-consume stage order", async () => {
    const skill = bodyOf(await readFile(skillPath, "utf8"));
    const fixture = await loadFixture();
    const stageMarkers: Readonly<Record<string, string>> = {
      init: "### 2. Initialize a draft contract",
      "populate-contract": "### 3. Build the authoritative review document",
      render: "### 4. Render both views in one transaction",
      "semantic-browser-check": "### 5. Validate meaning and real-browser behavior",
      deliver: "### 6. Deliver from the validated handoff",
      consume: "### 7. Consume reviewer feedback into a candidate round",
    };
    const positions = fixture.expectedStageOrder.map((stage) => {
      const marker = stageMarkers[stage];
      expect(marker, `Expected marker mapping for ${stage}`).toBeDefined();
      return skill.indexOf(marker ?? "");
    });

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("publishes only the exact Design 7.7 CLI commands", async () => {
    const fixture = await loadFixture();
    const skill = bodyOf(await readFile(skillPath, "utf8"));
    const protocol = await readFile(protocolPath, "utf8");
    const corpus = `${skill}\n${protocol}`;
    const allowed = new Set(
      Object.values(fixture.requiredCommands).map(normalizeWhitespace),
    );

    for (const [name, command] of Object.entries(fixture.requiredCommands)) {
      expect(normalizeWhitespace(corpus), name).toContain(normalizeWhitespace(command));
    }

    const publishedCommands = corpus
      .split("\n")
      .filter((line) => line.startsWith("node <skill>/scripts/review-delivery.mjs "))
      .map(normalizeWhitespace);
    expect(publishedCommands.length).toBeGreaterThan(0);
    for (const command of publishedCommands) {
      expect(allowed, command).toContain(command);
    }
  });

  it("states wire authority, reader isolation, review state, and consume boundaries", async () => {
    const corpus = normalizeWhitespace(
      [
        bodyOf(await readFile(skillPath, "utf8")),
        await readFile(protocolPath, "utf8"),
        await readFile(audiencePath, "utf8"),
      ].join("\n"),
    );

    expect(corpus).toMatch(/review-document\/1.*authoritative/iu);
    expect(corpus).toMatch(/review-packet\/1.*JSON.*only machine authority/iu);
    expect(corpus).toMatch(/review-state\/1.*never consume.*authority/iu);
    expect(corpus).toMatch(/Agent Markdown.*synthes/iu);
    expect(corpus).toMatch(/Approval HTML.*zero-context reviewer/iu);
    expect(corpus).toMatch(/reader isolation/iu);
    expect(corpus).toMatch(/partial approval.*untouched/iu);
    expect(corpus).toMatch(/reopen.*preserv.*approval history/iu);
    expect(corpus).toMatch(/consume.*already authored/iu);
    expect(corpus).toMatch(/do not authorize changes to external systems/iu);
  });

  it("requires current output confirmation, complete split handoff, and four-class disclosure", async () => {
    const skill = normalizeWhitespace(bodyOf(await readFile(skillPath, "utf8")));

    expect(skill).toMatch(/Before every .*init.*render.*consume.*write to a tracked location/iu);
    expect(skill).toMatch(/potentially public location.*disclosure risk.*explicit current confirmation/iu);
    expect(skill).toMatch(/local-only.*without an extra publication confirmation/iu);
    expect(skill).toMatch(/split reason.*judgment boundary.*total number of parts/iu);
    expect(skill).toMatch(/both Agent and Approval links for every part/iu);
    for (const name of [
      "evidenceGaps",
      "unresolvedNonblockingConflicts",
      "risks",
      "openQuestions",
    ]) {
      expect(skill).toContain(name);
    }
  });

  it("makes the low-context final reply mechanically complete from the current handoff", async () => {
    const skill = normalizeWhitespace(bodyOf(await readFile(skillPath, "utf8")));
    const fixture = await loadFixture();
    const handoff = getCase(fixture, "handoff-discloses-four-classes");

    expect(skill).toMatch(/context is sparse or compacted.*final reply for each handed-off document.*single delivery.*every part in a batch.*that document's current successful `handoff`/iu);
    expect(skill).toMatch(/For every document, state its `documentId`, `contentVersion`, `round`, and exact `asOf`/u);
    expect(skill).toMatch(/For every document.*exactly two canonical artifact links.*one Agent Markdown link and one Approval HTML link/iu);
    expect(skill).toMatch(/For that same document.*each non-empty uncertainty class.*class name, its exact count, and every `safeSummary`/iu);
    expect(handoff.perDocumentScope).toEqual([
      "single-delivery-document",
      "each-batch-part",
    ]);
    expect(handoff.perDocumentIdentityFieldsFromCurrentSuccessfulHandoff).toEqual([
      "documentId",
      "contentVersion",
      "round",
      "asOf",
    ]);
    expect(handoff.perDocumentCanonicalArtifactLinks).toEqual([
      "agentMarkdown",
      "approvalHtml",
    ]);
    expect(handoff.perDocumentDiscloseClassName).toBe(true);
    expect(handoff.perDocumentDiscloseExactCount).toBe(true);
    expect(handoff.perDocumentDiscloseEverySafeSummary).toBe(true);
  });

  it("keeps the Agent template continuation-complete and source-honest", async () => {
    const template = await readFile(agentTemplatePath, "utf8");
    const requiredSections = [
      "Document identity",
      "Objective and boundaries",
      "Source hierarchy",
      "Current state",
      "Shared evidence",
      "Decision blocks",
      "Approval history and lineage",
      "Next actions",
      "Validation evidence",
      "Glossary",
    ];

    expect(template).toMatch(/Generated from one validated review-document\/1/iu);
    expect(template).toMatch(/evidence synthesis, not a source of truth/iu);
    for (const section of requiredSections) {
      expect(template).toContain(`## ${section}`);
    }
    for (const placeholder of [
      "{{DOCUMENT_ID}}",
      "{{CONTENT_VERSION}}",
      "{{ROUND}}",
      "{{AS_OF}}",
      "{{DECISION_BLOCKS}}",
      "{{LINEAGE}}",
    ]) {
      expect(template).toContain(placeholder);
    }
    expect(template).not.toContain("claim:C-");
    expect(template).not.toContain("decision:D-");
  });

  it("records unambiguous workflow fixtures for later reader-isolation tests", async () => {
    const fixture = await loadFixture();
    const ids = fixture.cases.map((entry) => entry.id);
    const local = getCase(fixture, "local-only-initial-round");
    const tracked = getCase(fixture, "tracked-write-current-confirmation");
    const publicCase = getCase(fixture, "public-write-current-confirmation");
    const split = getCase(fixture, "valid-split-handoff");
    const partial = getCase(fixture, "partial-packet-preserves-untouched");
    const reopened = getCase(fixture, "reopen-preserves-history");
    const consume = getCase(fixture, "consume-validates-agent-authored-candidate");
    const handoff = getCase(fixture, "handoff-discloses-four-classes");

    expect(fixture.verificationScope).toMatch(/INT-001/iu);
    expect(new Set(ids).size).toBe(ids.length);
    expect(local.confirmOutputScope).toBeNull();
    expect(local.requireCurrentConfirmation).toBe(false);
    expect(tracked.confirmOutputScope).toBe("tracked");
    expect(tracked.requireCurrentConfirmation).toBe(true);
    expect(publicCase.confirmOutputScope).toBe("public");
    expect(publicCase.explainDisclosureRisk).toBe(true);
    expect(split.requiresReason).toBe(true);
    expect(split.requiresPartBoundary).toBe(true);
    expect(split.requiresTotal).toBe(true);
    expect(split.requiresTwoLinksPerPart).toBe(true);
    expect(split.treatsPartsAsRounds).toBe(false);
    expect(partial.untouchedActiveMeaning).toBe("pending");
    expect(partial.defaultAction).toBeNull();
    expect(reopened.preserveApprovalHistory).toBe(true);
    expect(reopened.suspendEligibilityUntilDecision).toBe(true);
    expect(consume.cliAuthorsSemanticChange).toBe(false);
    expect(consume.cliExecutesApprovedWork).toBe(false);
    expect(consume.approvalGrantsExternalAuthority).toBe(false);
    expect(handoff.perDocumentScope).toEqual([
      "single-delivery-document",
      "each-batch-part",
    ]);
    expect(handoff.perDocumentUncertaintyClasses).toEqual([
      "evidenceGaps",
      "unresolvedNonblockingConflicts",
      "risks",
      "openQuestions",
    ]);
    expect(handoff.perDocumentDiscloseEverySafeSummary).toBe(true);
  });
});
