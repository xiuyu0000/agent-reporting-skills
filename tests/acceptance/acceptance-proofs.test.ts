import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface CoverageCase {
  id: string;
  primaryTask: string;
  testId: string;
}

interface ProofLocation {
  file: string;
  declaration: string;
}

interface RegisteredProof extends ProofLocation {
  id: keyof typeof EXACT_OWNER_MAP;
  testId: string;
}

const EXACT_OWNER_MAP = {
  A01: "GEN-001",
  A02: "UI-003",
  A03: "UI-002",
  A04: "RND-001",
  A05: "RND-001",
  A06: "RND-001",
  A07: "RND-001",
  A08: "UI-003",
  A09: "CTR-002",
  A10: "UI-003",
  A11: "UI-003",
  A12: "CTR-002",
  A13: "GEN-001",
  A14: "SKL-001",
  A15: "VAL-001",
  A16: "RND-001",
  A17: "RND-001",
  A18: "CTR-002",
  A19: "UI-001",
  A20: "UI-002",
  A21: "RND-001",
  A22: "UI-003",
} as const;

const PRIMARY_PROOFS: Record<keyof typeof EXACT_OWNER_MAP, readonly ProofLocation[]> = {
  A01: [{ file: "tests/unit/generators.test.ts", declaration: 'it("A01_complete_review generates parser-valid Agent and Approval bytes from one snapshot"' }],
  A02: [{ file: "tests/browser/workbench-recovery.spec.ts", declaration: 'test("@A02 partial packet JSON and Markdown share one exact cached machine payload"' }],
  A03: [{ file: "tests/browser/workbench-actions.spec.ts", declaration: 'test("@A03 bulk confirmation passes only pending T0/T1 blocks"' }],
  A04: [{ file: "tests/e2e/consume.test.ts", declaration: 'it("A04_edit_incremental atomically commits only the validated next-round delivery"' }],
  A05: [{ file: "tests/e2e/consume.test.ts", declaration: 'it("A05_hold_answer commits the answered active block with incremented content version"' }],
  A06: [{ file: "tests/e2e/consume.test.ts", declaration: 'it("A06_topic_derivation binds Markdown once and commits candidate plus one derived delivery"' }],
  A07: [{ file: "tests/e2e/consume.test.ts", declaration: 'it("A07_finalize_unchanged publishes an unchanged-body finalized JSON round"' }],
  A08: [{ file: "tests/browser/workbench-recovery.spec.ts", declaration: 'test("@A08/@A17 reopening creates active controls and exports an unambiguous reopened PASS"' }],
  A09: [{ file: "tests/unit/contracts-migration.test.ts", declaration: 'it("A09_trim_expand_migration maps both legacy actions to visible EDIT semantics"' }],
  A10: [{ file: "tests/browser/workbench-recovery.spec.ts", declaration: 'test("@A10/@A22 storage degradation stays visible; explicit export quiets it only until the next change"' }],
  A11: [{ file: "tests/browser/workbench-recovery.spec.ts", declaration: 'test("@A11 clipboard rejection retains complete text and never reports success before manual confirmation"' }],
  A12: [{ file: "tests/unit/contracts-schema.test.ts", declaration: 'it("A12_protocol_fail_closed locates required and unknown fields"' }],
  A13: [{ file: "tests/e2e/split-group.test.ts", declaration: 'it("A13_split_or_block commits every consecutive part and returns the closed batch handoff"' }],
  A14: [{ file: "tests/unit/skill-interface.test.ts", declaration: 'describe("A14_trigger_boundary public Skill interface"' }],
  A15: [{ file: "tests/e2e/full-loop.test.ts", declaration: 'it("A15_artifact_drift rejects a changed generated artifact without a handoff"' }],
  A16: [{ file: "tests/unit/rounds-eligibility.test.ts", declaration: 'it("A16_transitive_hold suspends every transitive downstream while retaining approvals"' }],
  A17: [{ file: "tests/e2e/consume.test.ts", declaration: 'it("A17_reapprove_reopened retains approval history and commits the re-finalized round"' }],
  A18: [{ file: "tests/unit/contracts-migration.test.ts", declaration: 'it("A18_legacy_identity_confirmation refuses missing identity until all three values are explicit"' }],
  A19: [{ file: "tests/browser/workbench-render.spec.ts", declaration: 'test("@A19 fail closed for payload, identity, URL, and CSP tampering"' }],
  A20: [{ file: "tests/browser/workbench-actions.spec.ts", declaration: 'test("@A20 keyboard actions, focus trap, overwrite, undo, search, and topic pairing"' }],
  A21: [{ file: "tests/e2e/consume.test.ts", declaration: 'it("A21_global_topic_idempotent applies one legacy-derived topic then replays raw bytes as noop"' }],
  A22: [{ file: "tests/browser/workbench-recovery.spec.ts", declaration: 'test("@A22 a pending clipboard success cannot confirm a snapshot after state changes"' }],
};

const REGISTERED_PRIMARY_PROOFS: readonly RegisteredProof[] = [
  { id: "A01", testId: "A01_complete_review", ...PRIMARY_PROOFS.A01[0]! },
  { id: "A02", testId: "A02_partial_packet", ...PRIMARY_PROOFS.A02[0]! },
  { id: "A03", testId: "A03_bulk_excludes_t2", ...PRIMARY_PROOFS.A03[0]! },
  { id: "A04", testId: "A04_edit_incremental", ...PRIMARY_PROOFS.A04[0]! },
  { id: "A05", testId: "A05_hold_answer", ...PRIMARY_PROOFS.A05[0]! },
  { id: "A06", testId: "A06_topic_derivation", ...PRIMARY_PROOFS.A06[0]! },
  { id: "A07", testId: "A07_finalize_unchanged", ...PRIMARY_PROOFS.A07[0]! },
  { id: "A08", testId: "A08_reopen_frozen", ...PRIMARY_PROOFS.A08[0]! },
  { id: "A09", testId: "A09_legacy_actions", ...PRIMARY_PROOFS.A09[0]! },
  { id: "A10", testId: "A10_storage_degrade", ...PRIMARY_PROOFS.A10[0]! },
  { id: "A11", testId: "A11_clipboard_fallback", ...PRIMARY_PROOFS.A11[0]! },
  { id: "A12", testId: "A12_fail_closed", ...PRIMARY_PROOFS.A12[0]! },
  { id: "A13", testId: "A13_split_or_block", ...PRIMARY_PROOFS.A13[0]! },
  { id: "A14", testId: "A14_trigger_boundary", ...PRIMARY_PROOFS.A14[0]! },
  { id: "A15", testId: "A15_artifact_drift", ...PRIMARY_PROOFS.A15[0]! },
  { id: "A16", testId: "A16_transitive_hold", ...PRIMARY_PROOFS.A16[0]! },
  { id: "A17", testId: "A17_reapprove_reopened", ...PRIMARY_PROOFS.A17[0]! },
  { id: "A18", testId: "A18_state_identity", ...PRIMARY_PROOFS.A18[0]! },
  { id: "A19", testId: "A19_untrusted_content", ...PRIMARY_PROOFS.A19[0]! },
  { id: "A20", testId: "A20_keyboard_complete", ...PRIMARY_PROOFS.A20[0]! },
  { id: "A21", testId: "A21_global_topic_idempotent", ...PRIMARY_PROOFS.A21[0]! },
  { id: "A22", testId: "A22_export_dirty_again", ...PRIMARY_PROOFS.A22[0]! },
];

const PUBLICATION_AUTHORIZATION_PROOFS = [
  {
    command: "init",
    file: "tests/e2e/full-loop.test.ts",
    declaration: 'it("proves init local-only default and one-shot publication authorization"',
    proof: "distributed CLI: local-only default, mismatch rejection, matching tracked confirmation",
  },
  {
    command: "render",
    file: "tests/e2e/full-loop.test.ts",
    declaration: 'it("requires current authorization for tracked output and accepts the matching confirmation"',
    proof: "distributed CLI: missing confirmation rejection and matching tracked confirmation",
  },
  {
    command: "consume",
    file: "tests/e2e/consume.test.ts",
    declaration: 'it("sorts derived handoffs and requires the strictest derived publication confirmation before loader access"',
    proof: "public command runner: missing confirmation rejection and matching public confirmation",
  },
] as const;

async function coverageCases(): Promise<CoverageCase[]> {
  const path = resolve("tests/acceptance/coverage-map.json");
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    format: string;
    cases: CoverageCase[];
  };
  expect(parsed.format).toBe("acceptance-coverage/1");
  return parsed.cases;
}

describe("authoritative A01-A22 primary proof topology registry", () => {
  it("locks the exact task-card owner mapping and canonical test IDs", async () => {
    const cases = await coverageCases();
    expect(Object.fromEntries(cases.map(({ id, primaryTask }) => [id, primaryTask])))
      .toEqual(EXACT_OWNER_MAP);
    expect(cases.map(({ testId }) => testId)).toEqual([
      "A01_complete_review",
      "A02_partial_packet",
      "A03_bulk_excludes_t2",
      "A04_edit_incremental",
      "A05_hold_answer",
      "A06_topic_derivation",
      "A07_finalize_unchanged",
      "A08_reopen_frozen",
      "A09_legacy_actions",
      "A10_storage_degrade",
      "A11_clipboard_fallback",
      "A12_fail_closed",
      "A13_split_or_block",
      "A14_trigger_boundary",
      "A15_artifact_drift",
      "A16_transitive_hold",
      "A17_reapprove_reopened",
      "A18_state_identity",
      "A19_untrusted_content",
      "A20_keyboard_complete",
      "A21_global_topic_idempotent",
      "A22_export_dirty_again",
    ]);
  });

  it.each(REGISTERED_PRIMARY_PROOFS)(
    "$testId resolves to a real primary proof title",
    async ({ id, testId, file, declaration }) => {
      const cases = await coverageCases();
      const mapped = cases.find((item) => item.id === id);
      expect(mapped).toEqual({ id, primaryTask: EXACT_OWNER_MAP[id], testId });
      const source = await readFile(resolve(file), "utf8");
      expect(source, `${id} enabled proof declaration drifted in ${file}`).toContain(declaration);
      expect(declaration).toMatch(/^(?:it|test|describe)\("/u);
    },
  );

  it("keeps proof paths unique to an existing test file and never points at this bridge", async () => {
    const registry = Object.values(PRIMARY_PROOFS).flat();
    expect(registry.every(({ file }) => file !== "tests/acceptance/acceptance-proofs.test.ts"))
      .toBe(true);
    for (const { file, declaration } of registry) {
      const source = await readFile(resolve(file), "utf8");
      expect(source.split(declaration)).toHaveLength(2);
    }
  });

  it("is only a topology locator; runtime proof is supplied by executing every referenced suite", () => {
    expect(REGISTERED_PRIMARY_PROOFS).toHaveLength(22);
  });

  it.each(PUBLICATION_AUTHORIZATION_PROOFS)(
    "$command publication authorization proof is an exact enabled test declaration",
    async ({ file, declaration, proof }) => {
      const source = await readFile(resolve(file), "utf8");
      expect(source.split(declaration), proof).toHaveLength(2);
      expect(declaration).toMatch(/^it\("/u);
    },
  );
});
