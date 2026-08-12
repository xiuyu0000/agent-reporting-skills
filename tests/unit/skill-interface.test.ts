import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

type OutputKind =
  | "agent-markdown"
  | "approval-html"
  | "chat"
  | "code"
  | "human-narrative-html";

type ContractExpectation = "eligible" | "ineligible";
type PromptLanguage = "en" | "zh-CN";
type ReviewPhase = "initial" | "followup";

interface TriggerCase {
  readonly id: string;
  readonly language: PromptLanguage;
  readonly phase: ReviewPhase;
  readonly prompt: string;
  readonly approvalGoal: boolean;
  readonly primaryReviewerCount: number;
  readonly initialNaturalDecisionCount: number;
  readonly representedDecisionCount: number;
  readonly outputs: readonly OutputKind[];
  readonly contractExpectation: ContractExpectation;
  readonly negativeReason?: string;
}

interface TriggerFixture {
  readonly verificationScope: string;
  readonly cases: readonly TriggerCase[];
}

const skillPath = resolve("skills/deliver-dual-audience-report/SKILL.md");
const agentMetadataPath = resolve(
  "skills/deliver-dual-audience-report/agents/openai.yaml",
);
const triggerFixturePath = resolve(
  "tests/fixtures/skill-interface/trigger-cases.json",
);

function readQuotedYamlScalar(yaml: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = yaml.match(
    new RegExp(`^\\s*${escapedKey}:\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"),
  );

  expect(match, `Expected quoted YAML scalar ${key}`).not.toBeNull();
  return JSON.parse(match?.[1] ?? "null") as string;
}

function frontmatterOf(skill: string): string {
  const match = skill.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match, "Expected SKILL.md YAML frontmatter").not.toBeNull();
  return match?.[1] ?? "";
}

async function loadFixture(): Promise<TriggerFixture> {
  return JSON.parse(await readFile(triggerFixturePath, "utf8")) as TriggerFixture;
}

function getCase(fixture: TriggerFixture, id: string): TriggerCase {
  const candidate = fixture.cases.find((entry) => entry.id === id);
  expect(candidate, `Expected fixture ${id}`).toBeDefined();
  return candidate as TriggerCase;
}

function expectRequiredTriggerTerms(surface: string): void {
  expect(surface).toMatch(/one (?:primary human )?reviewer/i);
  expect(surface).toMatch(/approv(?:al|e)/i);
  expect(surface).toMatch(/initial (?:proposal|plan)/i);
  expect(surface).toMatch(/at least 4/i);
  expect(surface).toMatch(/natural(?:ly)?/i);
  expect(surface).toMatch(/independent(?:ly decidable)?/i);
  expect(surface).toMatch(/Agent(?:-facing)? Markdown/i);
  expect(surface).toMatch(/self-contained interactive Approval HTML/i);
}

describe("A14_trigger_boundary public Skill interface", () => {
  it("publishes all four positive trigger requirements in both public entry points", async () => {
    const skill = await readFile(skillPath, "utf8");
    const metadata = await readFile(agentMetadataPath, "utf8");
    const description = readQuotedYamlScalar(frontmatterOf(skill), "description");
    const defaultPrompt = readQuotedYamlScalar(metadata, "default_prompt");

    expectRequiredTriggerTerms(description);
    expectRequiredTriggerTerms(defaultPrompt);
    expect(defaultPrompt).toContain("$deliver-dual-audience-report");
    expect(defaultPrompt).toMatch(/lighter workflow otherwise/i);
  });

  it("states every exclusion and forbids threshold padding in the trigger description", async () => {
    const skill = await readFile(skillPath, "utf8");
    const description = readQuotedYamlScalar(frontmatterOf(skill), "description");

    expect(description).toMatch(/fewer than 4 natural decision items/i);
    expect(description).toMatch(/multiple or parallel reviewers/i);
    expect(description).toMatch(/exploratory reading without approval/i);
    expect(description).toMatch(/a single Markdown or HTML report/i);
    expect(description).toMatch(/a chat-only answer/i);
    expect(description).toMatch(/code-only work without a separate plan approval deliverable/i);
    expect(description).toMatch(/legacy static Agent report plus human narrative HTML/i);
    expect(description).toMatch(/never split or pad content merely to reach 4/i);
    expect(description).not.toContain("_HUMAN.html");
  });

  it("keeps UI metadata valid and aligned with the approval workflow", async () => {
    const metadata = await readFile(agentMetadataPath, "utf8");
    const displayName = readQuotedYamlScalar(metadata, "display_name");
    const shortDescription = readQuotedYamlScalar(metadata, "short_description");

    expect(displayName).toBe("Single-Reviewer Approval Delivery");
    expect(shortDescription.length).toBeGreaterThanOrEqual(25);
    expect(shortDescription.length).toBeLessThanOrEqual(64);
    expect(shortDescription).toMatch(/approval/i);
    expect(metadata).toMatch(/^policy:\n\s{2}allow_implicit_invocation: true$/m);
  });

  it("documents bilingual fixture expectations for later INT-001 fresh-agent routing tests", async () => {
    const fixture = await loadFixture();
    const ids = fixture.cases.map(({ id }) => id);
    const eligible = fixture.cases.filter(
      ({ contractExpectation }) => contractExpectation === "eligible",
    );
    const ineligible = fixture.cases.filter(
      ({ contractExpectation }) => contractExpectation === "ineligible",
    );
    const chinese = fixture.cases.filter(({ language }) => language === "zh-CN");

    // This unit test intentionally does not infer intent from prompt text. INT-001
    // owns fresh-Agent validation of the English and Chinese routing semantics.
    expect(fixture.verificationScope).toMatch(/INT-001 fresh-agent/i);
    expect(new Set(ids).size).toBe(ids.length);
    expect(eligible.length).toBeGreaterThan(0);
    expect(ineligible.length).toBeGreaterThan(0);
    expect(chinese.some(({ contractExpectation }) => contractExpectation === "eligible")).toBe(true);
    expect(chinese.some(({ contractExpectation }) => contractExpectation === "ineligible")).toBe(true);

    for (const candidate of fixture.cases) {
      expect(candidate.prompt.trim(), candidate.id).not.toBe("");
      if (candidate.language === "zh-CN") {
        expect(candidate.prompt, candidate.id).toMatch(/\p{Script=Han}/u);
      }

      if (candidate.contractExpectation === "eligible") {
        expect(candidate.negativeReason, candidate.id).toBeUndefined();
      } else {
        expect(candidate.negativeReason?.trim(), candidate.id).not.toBe("");
      }
    }
  });

  it("records initial-natural versus represented-count boundary expectations", async () => {
    const fixture = await loadFixture();
    const followups = fixture.cases.filter(({ phase }) => phase === "followup");
    const padded = getCase(fixture, "artificial-padding");

    expect(followups.length).toBeGreaterThanOrEqual(2);
    for (const followup of followups) {
      expect(followup.contractExpectation, followup.id).toBe("eligible");
      expect(followup.initialNaturalDecisionCount, followup.id).toBeGreaterThanOrEqual(4);
      expect(followup.representedDecisionCount, followup.id).toBeLessThan(4);
      expect(followup.approvalGoal, followup.id).toBe(true);
      expect(followup.primaryReviewerCount, followup.id).toBe(1);
      expect(followup.outputs, followup.id).toEqual(
        expect.arrayContaining(["agent-markdown", "approval-html"]),
      );
    }

    expect(padded.phase).toBe("initial");
    expect(padded.contractExpectation).toBe("ineligible");
    expect(padded.initialNaturalDecisionCount).toBeLessThan(4);
    expect(padded.representedDecisionCount).toBeGreaterThanOrEqual(4);
    expect(padded.negativeReason).toMatch(/padding/i);
  });
});
