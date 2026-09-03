# Review protocols and CLI contract

Use this reference when writing or checking `review-document/1`, importing
review data, preparing a candidate round, splitting a delivery, or invoking the
public CLI. Use the three public JSON Schemas linked directly from `SKILL.md` as
the field-shape authority.

## Contents

- [Authority and identities](#authority-and-identities)
- [Build a review document](#build-a-review-document)
- [Triage decision blocks](#triage-decision-blocks)
- [Enforce size and split rules](#enforce-size-and-split-rules)
- [Apply review actions](#apply-review-actions)
- [Calculate progress and reopen frozen blocks](#calculate-progress-and-reopen-frozen-blocks)
- [Distinguish packet, packet Markdown, and state](#distinguish-packet-packet-markdown-and-state)
- [Normalize supported history](#normalize-supported-history)
- [Prepare and consume the next round](#prepare-and-consume-the-next-round)
- [Use the exact CLI interface](#use-the-exact-cli-interface)
- [Fail closed](#fail-closed)

## Authority and identities

Treat `review-document/1` JSON as the authoritative generation and transition
input. Generate Agent Markdown and Approval HTML together from one validated
document; never promote either generated view into a second factual authority.

Keep these identities distinct:

- `delivery.id` identifies one output delivery.
- `document.id` remains stable across every round of one proposal.
- `document.contentVersion` is a positive integer that changes only when
  semantic content changes.
- `document.round` is a positive integer that increases exactly once after the
  first successful consumption of each new valid packet; an idempotent no-op
  does not increment it.
- `review-packet/1` and `review-state/1` each have their own format identity.

Keep block IDs stable across rounds. Allocate `B001`, `B002`, and later values
monotonically and never reuse one. Preserve high-water marks for block, source,
fact, decision, glossary, note, and topic IDs even after deleting an entry.

Use `draft` only while the Agent is filling a new contract. Change it explicitly
to `in-review` before render. Use `finalized` only when the all-frozen invariants
hold. Do not ask the CLI to infer or promote status.

Reject `dual-audience-report-contract-v1` as an incompatible interface. Do not
guess a migration to `review-document/1`.

## Build a review document

Fill the contract in this order:

1. Set delivery identity, safe base name, output paths, repository
   classification, and optional split-group metadata.
2. Set document identity, title, BCP-47 content language, supported UI locale,
   content version, timezone-qualified as-of time, round, status, and summary.
3. Fill continuation objective, scope, exclusions, current state, next actions,
   validation evidence, and evidence gaps.
4. Rank sources and connect every shared fact and existing decision to source
   IDs with confidence.
5. Preserve constraints, risks, open questions, and source conflicts as
   separate fields.
6. Add independently decidable blocks in proposal narrative order.
7. Add only glossary entries needed to understand the proposal offline, and
   bind every professional term left in prose to its entry with a `termRef`
   node; an unlinked professional term is an authoring defect (see the
   audience contract's plain-language rules).
8. Preserve approval history, current frozen IDs, ID high-water marks, consumed
   packets, topic mappings, impact assessments, and feedback resolutions.

Use only supported structured content nodes: paragraphs, one-level lists,
tables, inert code, controlled callouts, controlled steps, controlled flows, and
ranked scales; use text, strong text, emphasis, inline code, safe links, and
glossary terms inline. Reject unknown nodes. Keep table width, flow references,
term references, scale positions, and URLs valid. Never insert raw HTML or
executable content.

A flow node and edge may carry an optional `kind`. Use `start`, `step`,
`decision` or `end` on a node and `then`, `yes`, `no` or `else` on an edge; the
renderer draws the matching shape and repeats the word in the text alternative,
so meaning never rests on shape alone.

Refresh time-sensitive sources used by core facts or decisions before render.
Stop on an unresolved blocking evidence conflict.

## Triage decision blocks

Create a block only when the reviewer can decide it independently. Keep its
title within 32 display columns and summary within 80 display columns.

Assign `T2` when any one of these conditions holds:

- the choice is irreversible;
- it commits significant resources;
- it is externally visible;
- it departs from precedent;
- Agent confidence is insufficient; or
- it touches an interest the reviewer explicitly identified.

For every T2 block, write both a non-empty `whyTier` and a concrete non-empty
`ask`. Require an explicit per-block decision; never include T2 in bulk PASS.

Assign `T1` when the reviewer needs to understand context, reason, or risk but
does not need to choose. Assign `T0` only for routine, reliable-precedent,
reversible work. Let the reviewer use any action on any active tier. Re-triage a
T0 or T1 block after EDIT or HOLD instead of mechanically retaining its tier.

Keep every dependency inside the current document. Reject missing, self, and
cyclic dependencies.

## Enforce size and split rules

Count every displayed block, including frozen blocks. Keep one round within:

- 4–15 total blocks; and
- 0–7 T2 blocks.

Stop before render when either upper limit is exceeded. Split only when every
part:

- has an independent document and delivery identity;
- has 4–15 blocks and at most 7 T2 blocks;
- can be understood independently;
- contains the complete dependency closure of all its blocks; and
- belongs to one complete `splitGroup` with a non-empty reason, consecutive
  part number, and common total.

Pass every part to one batch render or batch validation. Commit none when one
part is missing or invalid. Report a blocker instead of delivering a warning
when no valid split exists. Do not represent initial batching as later approval
rounds.

Use the successful batch handoff to report the group reason, total, each part's
judgment boundary, and both generated paths for every part.

Treat a `warnings` entry with code `APPROVAL_PAYLOAD_NEAR_LIMIT` or
`APPROVAL_PAYLOAD_OVER_LIMIT` as a size signal of the same kind: the canonical
contract is within 1,536 bytes of, or past, the 49,152-byte payload that
workbenches generated before the multi-text-node reader can load in WebKit
browsers (`payloadBytes` and `limitBytes` carry the counts; `path` names the
document or the `/batch/parts/N` part). Prefer trimming non-semantic fields or
splitting in round 1, because each later round adds roughly 700–800 bytes of
approval bookkeeping. A warning never blocks the delivery.

## Apply review actions

Use exactly four block actions:

| Action | Required reviewer input | Candidate-round meaning |
|---|---|---|
| `PASS` | none | Freeze the source block at the consumed round; grant execution eligibility only when its full dependency closure is eligible. |
| `EDIT` | executable change request; optional quote | Change only the source block, describe the current-round change, and reopen it for review. |
| `TOPIC` | topic title; optional note | Derive exactly one independent proposal; keep the source block unchanged, unapproved, active, and pending. |
| `HOLD` | question that must be answered | Do not execute the source block; answer, re-triage, and reopen it in the candidate round. |

Let a later action replace an earlier action on the same active block. Let the
reviewer undo an action and return the block to pending. Treat a side note as
context only; do not count it as a decision or silently execute it.

Pair every block-level TOPIC decision with exactly one topic entry having the
same source block. Delete or replace the paired topic when its decision is
deleted or replaced. Keep global topics separate from block decisions; derive
each global topic exactly once and record its successful consumption.

Do not treat PASS or dependency eligibility as permission to change external
systems, files, people, or production. Apply the execution task's own authority
and safety rules after approval.

## Calculate progress and reopen frozen blocks

Count all active blocks in the progress denominator. Count active blocks with a
current action in the numerator. Exclude frozen blocks and side notes from both.

Export a packet at any time. Mark it partial when any active block remains
pending. Preserve every untouched pending block as active; never infer PASS,
HOLD, or abandonment.

Bulk-PASS only pending active T0/T1 blocks after an in-page second confirmation.
Exclude T2, frozen blocks, blocks with non-PASS actions, and blocks outside the
current scope. Report how many blocks changed and that T2 remained untouched.

Require an explicit reopen action before reviewing a frozen block. Preserve its
approval history, remove it from the currently frozen set, place it in the
active progress denominator, and suspend its current eligibility. Put an
undecided reopened block in the packet's reopened set but not its frozen-carried
set. Freeze it again only after a new valid PASS.

## Distinguish packet, packet Markdown, and state

Treat `review-packet/1` JSON as the only machine-readable feedback authority.
Recalculate progress, partial status, statistics, frozen-carried IDs, reopened
IDs, decisions, notes, topics, high-water marks, semantic digest, and packet ID
from detail. Reject a conflicting summary.

Treat packet Markdown as a deterministic readable rendering of that same
packet. Require exactly one complete four-backtick JSON payload. Parse only that
payload as authority, then revalidate its identity and digest. Reject missing,
duplicate, truncated, or contradictory payloads.

Treat `review-state/1` as a mutable recovery overlay bound to exact document ID,
content version, round, and review digest. Restore decisions, notes, topics,
overall feedback, reopened IDs, and ID high-water marks. Do not carry progress,
statistics, frozen-carried IDs, or execution eligibility as trusted state.
Never consume state as approval, revision, or execution authority.

Reject any failed state or packet import atomically. Keep the current in-memory
state unchanged and report a stable error location.

## Normalize supported history

Accept historical `TRIM` and `EXPAND` only through the explicit
`prototype-v1` profile. Convert either action to `EDIT` and preserve the old
meaning visibly in the note. Recalculate normalized detail, progress, and
statistics before replacing state. Emit only PASS, EDIT, TOPIC, and HOLD.

Require the source document ID, content version, and round. When the historical
input lacks identity, require all three explicit confirmation flags and verify
them against the current contract. Reject unknown actions, unknown future
formats, and ambiguous identity. Do not guess.

## Prepare and consume the next round

Have the Agent author the candidate document before calling `consume`:

1. Validate packet identity, detail, action, dependency, topic mapping, frozen
   carry, reopened state, progress, statistics, and idempotency.
2. Freeze every PASS source block at the current approval round.
3. Modify only EDIT source blocks and mark them changed in the candidate round.
4. Answer every HOLD, re-triage its source block, and keep it active.
5. Keep every TOPIC source block unchanged and active; author exactly one
   independent derived document for its paired topic.
6. Author exactly one derived document for each unconsumed global topic.
7. Preserve every untouched frozen block byte-for-byte and every untouched
   pending block as active.
8. Record every changed upstream block's affected downstream closure and reason;
   reopen the complete transitive closure when impact cannot be narrowed safely.
9. Resolve every side note and non-empty overall comment exactly once as
   context-only or converted to a valid block.
10. Increment round exactly once, update content version mechanically, preserve
    all append-only lineage, and retain monotonic ID high-water marks.

Suspend eligibility for every downstream block whose transitive dependency is
pending, reopened without a decision, EDIT, HOLD, or TOPIC. Preserve historical
approval while eligibility is suspended. Require explicit reopen and approval
for a downstream block affected by an upstream semantic change.

Finalize without changing block bodies only when every active block is PASS,
there is no EDIT, HOLD, or block TOPIC, every global topic is successfully
derived and recorded, and no side note or overall comment requests a proposal
change. Remove current-round change markers and retain every approval round.

Let `consume` validate and atomically publish the already-authored candidate and
derived documents. Do not expect it to write semantic revisions, answer HOLD,
select impact sets, or execute approved work. Treat the same packet ID and
semantic digest as an idempotent successful no-op; reject an ID reused with a
different digest.

## Use the exact CLI interface

Resolve `<skill>` to the installed Skill directory. Do not invent flags.

### Initialize

```text
node <skill>/scripts/review-delivery.mjs init --output-dir <dir> --base-name <name> --title <title> --language <bcp47> --ui-locale <zh-CN|en> --as-of <iso8601-with-timezone> [--contract-name <review-document.json|baseName.review-document.json>] [--repository-status <local-only|tracked-approved|public-approved>] [--confirm-output-scope <tracked|public>]
```

Expect a new safe output directory and draft contract only. Refuse an existing
target. Pass the confirmation flag only after current explicit authorization
for the matching tracked or public write.

### Render

```text
node <skill>/scripts/review-delivery.mjs render --document <review-document.json> [--document <part.review-document.json> ...] [--replace-generated] [--confirm-output-scope <tracked|public>]
```

Pass all split-group members in one command. Keep the contract read-only. Use
replacement only for identity-matching generated outputs.

### Validate

```text
node <skill>/scripts/review-delivery.mjs validate delivery --document <path>
node <skill>/scripts/review-delivery.mjs validate batch --document <part1.review-document.json> --document <part2.review-document.json> [...]
node <skill>/scripts/review-delivery.mjs validate packet --document <path> --input <packet.json|packet.md> [--legacy-profile prototype-v1 --confirm-document-id <id> --confirm-content-version <n> --confirm-round <n>]
node <skill>/scripts/review-delivery.mjs validate state --document <path> --input <state.json> [--legacy-profile prototype-v1 --confirm-document-id <id> --confirm-content-version <n> --confirm-round <n>]
node <skill>/scripts/review-delivery.mjs validate transition --current <path> --packet <path> --candidate <path> [--derived <topicId=path> ...]
```

Keep all validation modes read-only. Save any returned normalized historical
object only through an explicit caller action.

### Consume

```text
node <skill>/scripts/review-delivery.mjs consume --current <review-document.json> --packet <packet.json|packet.md> --candidate <next-review-document.json> [--derived <topicId=review-document.json> ...] [--legacy-profile prototype-v1 --confirm-document-id <id> --confirm-content-version <n> --confirm-round <n>] [--confirm-output-scope <tracked|public>] --output-dir <fresh-dir>
```

Require a fresh output directory. Pass every derived topic mapping. Pass a
tracked or public confirmation only after the current write is explicitly
authorized.

### Record content-free use

```text
node <skill>/scripts/review-delivery.mjs record-usage append --input <content-free-metrics.json>
node <skill>/scripts/review-delivery.mjs record-usage summarize --min-samples 3 --max-samples 5
```

Keep metrics content-free. Treat `not-recorded` as non-blocking and never invent
success.

## Fail closed

Reject before mutation when any of these conditions holds:

- unsupported format, field, action, content node, URL, or future protocol;
- missing or mismatched document, delivery, content version, round, review
  digest, packet digest, or state digest;
- duplicate or reused ID, regressed high-water mark, missing reference, bad
  dependency, self-dependency, or cycle;
- missing T2 rationale or question, invalid block count, or invalid split group;
- stale core evidence or unresolved blocking evidence conflict;
- frozen content drift, unauthorized changed marker, modified untouched block,
  incomplete impact set, or invalid finalization;
- inconsistent progress, statistics, TOPIC pairing, frozen carry, reopened set,
  feedback resolution, or append-only lineage;
- unsafe path, symbolic-link escape, normalization collision, unconfirmed
  tracked/public scope, unsafe replacement, or untrusted executable content; or
- malformed, incomplete, ambiguous, or mismatched state or packet.

Return a stable error code, JSON path, optional block ID, safe message, and
recovery hint. Leave inputs and current state unchanged. Do not interpret a
failed command as delivery. Treat a successful idempotent no-op as non-mutating
success.
