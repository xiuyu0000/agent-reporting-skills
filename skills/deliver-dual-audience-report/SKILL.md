---
name: deliver-dual-audience-report
description: "Deliver one verified plan as precise Agent-facing Markdown for continuation and a self-contained interactive Approval HTML for decision and feedback. Use only when one primary human reviewer has an explicit approval, review, or item-by-item feedback goal and the initial proposal naturally contains at least 4 independently decidable items; the same contract continues through later revision rounds. Do not use for fewer than 4 natural decision items, multiple or parallel reviewers, exploratory reading without approval, a single Markdown or HTML report, a chat-only answer, code-only work without a separate plan approval deliverable, or the legacy static Agent report plus human narrative HTML workflow. Never split or pad content merely to reach 4 items."
compatibility: "Requires Node.js on PATH to run scripts/review-delivery.mjs; the validated contract runtime is Node 24 LTS (>=24 <25). No npm install, node_modules, or network access is needed at runtime, and generated artifacts are self-contained offline HTML/Markdown."
---

# Deliver Dual-Audience Report

Create one verified `review-document/1`, then deliver two generated views:
precise Agent Markdown for continuation and a self-contained interactive
Approval HTML for one human reviewer. Treat the JSON contract as authoritative.
Treat both views as evidence syntheses, not as new factual sources.

## Read only what the stage needs

- Read [audience contracts](references/audience-contracts.md) before checking
  each view and running reader-isolation tests.
- Read [evidence and privacy](references/evidence-and-privacy.md) before
  collecting sources or selecting an output boundary.
- Read [review protocols](references/review-protocols.md) before writing a
  contract, importing feedback, splitting a delivery, or consuming a round.
- Read the public [document](references/review-document.schema.json),
  [packet](references/review-packet.schema.json), and
  [state](references/review-state.schema.json) Schemas when field-level shape is
  needed. Do not reconstruct fields from prose.

Reject `dual-audience-report-contract-v1` as incompatible input. Do not infer a
new approval contract from it and do not produce a seemingly valid workbench.

## Follow the approval workflow

### 1. Establish authority and output scope

Record the title, content language, UI locale, as-of time, source priority,
output directory, base name, and whether the destination is local-only,
tracked, or potentially public.

Keep local-only writes inside the agreed local boundary without an extra
publication confirmation. Before every `init`, `render`, or `consume` write to
a tracked location, explain the exact target scope and repository exposure risk,
then obtain explicit current confirmation. Before every such write to a
potentially public location, explain the target scope and disclosure risk and
obtain explicit current confirmation. Only then pass the matching one-time
`--confirm-output-scope <tracked|public>` value. Never treat a stored
`repositoryStatus` value or an earlier confirmation as permission.

### 2. Initialize a draft contract

Run the installed Skill CLI with the exact public interface:

```text
node <skill>/scripts/review-delivery.mjs init --output-dir <dir> --base-name <name> --title <title> --language <bcp47> --ui-locale <zh-CN|en> --as-of <iso8601-with-timezone> [--contract-name <review-document.json|baseName.review-document.json>] [--repository-status <local-only|tracked-approved|public-approved>] [--confirm-output-scope <tracked|public>]
```

Use `local-only` unless the current conversation authorizes a broader boundary.
Expect `init` to create only a draft `review-document/1` skeleton. Do not claim
that it created deliverable views or a valid empty workbench.

### 3. Build the authoritative review document

Populate the contract from verified sources. Refresh every time-sensitive
source used by a core fact or decision before render. Expose unresolved source
conflicts; stop on any unresolved blocking conflict.

Write continuation context, evidence, decisions, constraints, risks, open
questions, glossary entries, approval history, and lineage in the JSON
contract. Use only supported structured content nodes. Use stable IDs and never
reuse an ID after deletion or across rounds. Use
[the Agent context template](assets/agent-context.template.md) as a coverage
guide, not as a second source of truth and not as a file to hand-edit after
generation.

Split the proposal into decision blocks by independent judgment, not by
paragraph. Assign T2 when any consequence condition requires the reviewer to
decide; include both `whyTier` and a concrete `ask`. Assign T1 only when the
reviewer needs context but no choice, and T0 only for routine, precedent-backed,
reversible work. Keep every round at 4–15 blocks and no more than 7 T2 blocks.

When limits require multiple documents, create independent document and
delivery identities, keep every dependency inside one part, keep every part
within the same limits, and record one `splitGroup` with its reason, consecutive
part numbers, and total. Report a blocker when no independently understandable,
dependency-closed split exists. Never disguise initial batching as revision
rounds.

Set the completed draft to `in-review`; do not ask the CLI to make semantic
judgments or promote it automatically.

### 4. Render both views in one transaction

Run one command for one document or all members of a split group:

```text
node <skill>/scripts/review-delivery.mjs render --document <review-document.json> [--document <part.review-document.json> ...] [--replace-generated] [--confirm-output-scope <tracked|public>]
```

Render the Agent Markdown and Approval HTML together from the same validated
contract and generator version. Never hand-edit either generated view. Treat a
missing success result as incomplete. Use `--replace-generated` only for
identity-matching generated files and only when replacement is intended.

A successful `render` or `validate delivery`/`batch` result may carry a
`warnings` array beside `handoff`. `APPROVAL_PAYLOAD_NEAR_LIMIT` means the
embedded contract is within 1,536 bytes of, and `APPROVAL_PAYLOAD_OVER_LIMIT`
that it is past, the 49,152-byte payload that workbenches generated before
the multi-text-node reader could load in WebKit browsers. Warnings never
change the exit code; trim non-semantic fields or split the delivery in
round 1, because each later round adds approval bookkeeping.

### 5. Validate meaning and real-browser behavior

Run the applicable read-only validation:

```text
node <skill>/scripts/review-delivery.mjs validate delivery --document <path>
node <skill>/scripts/review-delivery.mjs validate batch --document <part1.review-document.json> --document <part2.review-document.json> [...]
```

Then compare both views against the contract for semantic agreement. Open the
Approval HTML offline in a real browser. Check desktop and narrow layouts,
keyboard-only operation, visible focus, readable decision context, zero network
requests, and safe treatment of untrusted text.

Run reader isolation when validating the delivery: give only the Agent Markdown
to a fresh Agent and verify that it can continue without hidden context; give
only the Approval HTML to a zero-context reviewer and verify that they can
understand and decide without another report or an external link. Fix any gap
in the contract and rerender both views.

### 6. Deliver from the validated handoff

Even when conversation context is sparse or compacted, compose the final reply
for each handed-off document—one document in a single delivery or every part in
a batch—only from that document's current successful `handoff`; do not guess,
cache, or reconstruct it. For every document, state its `documentId`,
`contentVersion`, `round`, and exact `asOf`, and include exactly two canonical
artifact links from its handoff: one Agent Markdown link and one Approval HTML
link. For that same document, disclose each non-empty uncertainty class
separately: `evidenceGaps`, `unresolvedNonblockingConflicts`, `risks`, and
`openQuestions`. For each one, state the class name, its exact count, and every
`safeSummary` returned for that class.

For a split group, first state the split reason, each part's judgment boundary,
and the total number of parts. Then provide both Agent and Approval links for
every part. Do not call the parts revision rounds.

### 7. Consume reviewer feedback into a candidate round

Treat `review-packet/1` JSON as the only machine authority. Treat packet
Markdown as a deterministic readable view containing one complete JSON payload.
Treat `review-state/1` only as a resumable browser overlay; never consume it as
approval, revision, or execution authority.

Accept partial approval without defaulting untouched blocks. Preserve every
untouched active block. Keep frozen blocks out of progress until the reviewer
explicitly reopens them. Preserve approval history when reopening, suspend
current execution eligibility, and require a new decision before freezing the
block again.

Before running `consume`, write the candidate next `review-document/1` and every
derived TOPIC document. Apply PASS by freezing the approved source block; apply
EDIT only to its source block; answer HOLD before resubmitting and re-triaging
the block; derive exactly one independent proposal for each TOPIC without
changing or approving its source block. Resolve every side note and non-empty
overall comment explicitly in lineage. Preserve all untouched content and
assess the full downstream impact of changed dependencies.

Optionally validate the transition before writing:

```text
node <skill>/scripts/review-delivery.mjs validate transition --current <path> --packet <path> --candidate <path> [--derived <topicId=path> ...]
```

Then publish the verified candidate and derived documents atomically:

```text
node <skill>/scripts/review-delivery.mjs consume --current <review-document.json> --packet <packet.json|packet.md> --candidate <next-review-document.json> [--derived <topicId=review-document.json> ...] [--legacy-profile prototype-v1 --confirm-document-id <id> --confirm-content-version <n> --confirm-round <n>] [--confirm-output-scope <tracked|public>] --output-dir <fresh-dir>
```

Let `consume` validate and publish what the Agent already authored. Never ask it
to write EDIT revisions, answer HOLD questions, choose impact sets, or execute
approved work. Approval and dependency eligibility do not authorize changes to
external systems, files, people, or production; obtain whatever permission the
actual execution task requires.

### 8. Record content-free use only after validation

Record optional metrics without titles, document IDs, paths, filenames,
projects, prompts, dialogue, commands, outputs, session identifiers,
credentials, or deliverable content:

```text
node <skill>/scripts/review-delivery.mjs record-usage append --input <content-free-metrics.json>
node <skill>/scripts/review-delivery.mjs record-usage summarize --min-samples 3 --max-samples 5
```

Treat `not-recorded` as a measurement gap, not as a delivery failure. Never
invent a usage record.

## Fail closed

- Stop before writing on an unconfirmed tracked or public boundary.
- Stop on invalid identity, unknown protocol/action/node, stale core evidence,
  duplicate ID, bad or cyclic dependency, frozen-content drift, mismatched
  statistics, malformed state or packet, path escape, or unsafe content.
- Stop before render when the 15/7 limits cannot be resolved by a valid split.
- Leave inputs and current state unchanged on every failed validation or
  import. Report the stable error location and recovery guidance.
- Treat an idempotent repeated packet as a successful no-op; never derive or
  execute it twice.

## Bundled resources

- Use `scripts/review-delivery.mjs` as the single public command entry point.
- Use `assets/agent-context.template.md` only for Agent-view coverage.
- Read `references/review-protocols.md` for actions, rounds, wire authority, and
  exact CLI behavior.
- Read `references/audience-contracts.md` for two-view responsibilities and
  isolation checks.
- Read `references/evidence-and-privacy.md` for source, freshness, disclosure,
  and output-boundary rules.
- Read the three directly linked public Schemas for exact field shape.
