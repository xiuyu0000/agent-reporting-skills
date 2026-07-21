---
name: deliver-dual-audience-report
description: "Deliver one verified evidence set as two complete artifacts: precise Agent-facing Markdown and zero-context human-facing HTML. Use when the user explicitly requests, or the accepted plan explicitly promises, both Agent and human versions of a project summary, research report, incident review, decision record, or similar report. Also use when resuming such a task to verify that both promised files were actually created and linked. Do not use for a single Markdown or HTML report, a chat-only answer, or a code-only task."
---

# Deliver Dual-Audience Report

## Overview

Create two genuinely different reading paths from one shared fact contract, then
prove that both artifacts were completed. Keep research and writing judgment
flexible; use the bundled scripts only for initialization and deterministic
delivery checks.

## Non-negotiable outcome

The task is incomplete until both required artifacts exist, validate, and are
linked in the handoff. A sentence promising a future document is not delivery.

Use one fact inventory, but do not copy one document into the other:

- The Agent document optimizes for precise continuation.
- The human document optimizes for understanding with no prior context.

## Trigger boundary

Use this Skill only when two audiences and two artifacts are part of the actual
delivery contract. Do not infer a second deliverable merely because both agents
and humans may read the result.

If the destination is unclear and choosing it could expose private material or
modify tracked/public state, ask before creating files. User-provided template,
filename, language, and destination instructions override defaults.

## Workflow

### 1. Confirm the two-artifact contract

Record before drafting:

- title, language, as-of time, output directory, and repository/public status;
- authoritative sources in priority order;
- exact Agent and human filenames;
- required facts, decisions, constraints, risks, and open questions;
- any explicit waiver. Never invent a waiver because one artifact is harder.

Read [references/audience-contracts.md](references/audience-contracts.md) for the
content contract and [references/evidence-and-privacy.md](references/evidence-and-privacy.md)
for evidence and privacy rules.

### 2. Create both files early

Run:

```bash
python3 scripts/init_delivery.py \
  --output-dir <target> \
  --base-name <stable-name> \
  --title <title> \
  --language <language> \
  --as-of <ISO-8601 timestamp>
```

Resolve the script relative to this Skill directory. It creates
`report-contract.json` plus both artifact skeletons. Do not wait until the end
to create the second file.

### 3. Freeze one evidence snapshot

Resolve conflicts using the recorded source hierarchy. Put core claims and
decisions in `report-contract.json`, with confidence and source references.
Refresh volatile facts immediately before final validation. The reports are
syntheses, never new sources of truth.

### 4. Design two reading paths

For the Agent Markdown, prioritize exact scope, current state, constraints,
interfaces, commands or pseudocode, decisions and rationale, risks, blockers,
next actions, and validation evidence. State that it is a synthesis rather than
a source of truth.

For the human HTML, lead with the conclusion and why it matters. Explain what
happened, why, impact, choices, and next steps. Use a small flow, timeline, or
comparison only when it materially clarifies the story. Define necessary terms
nearby or link them to an appendix glossary. Keep it self-contained,
responsive, keyboard-accessible, and free of CDN/runtime dependencies.

The two outlines and wording may differ. Their core facts, decisions, as-of
time, and constraints may not.

### 5. Record shared claims

For every required claim and decision in the contract, include its marker in
both artifacts. The templates show the syntax. Markers contain a stable ID and
the SHA-256 digest of the contract summary; the validator uses them to detect
stale or mismatched core statements.

### 6. Validate before handoff

Run:

```bash
python3 scripts/validate_delivery.py --contract <target>/report-contract.json
```

Fix every failure. Also render the HTML in a real browser when one is available
and inspect desktop and narrow layouts. The deterministic validator cannot
judge whether prose is truly clear or whether two differently worded passages
contradict each other; perform that semantic review explicitly.

### 7. Deliver both links together

Use the generated `delivery-receipt.md` as the checklist. In the final response,
link both real files. Mention the as-of time and any remaining uncertainty. Do
not claim completion if only one link is present.

## Failure handling

- Stop if a source conflict changes the conclusion; expose it instead of
  silently choosing.
- Stop if the target path could leak private content into tracked/public state.
- Fail closed if validation cannot run or the contract cannot be parsed.
- An explicitly waived artifact must have a user-authored reason in the
  contract. A waiver changes the task and should be rare.

## Bundled resources

- `scripts/init_delivery.py`: create the contract and both skeletons.
- `scripts/validate_delivery.py`: validate and generate delivery receipts.
- `references/report-contract.schema.json`: public data contract.
- `references/audience-contracts.md`: audience-specific content requirements.
- `references/evidence-and-privacy.md`: source, freshness, and privacy rules.
- `assets/agent-report.template.md` and `assets/human-report.template.html`:
  portable starting structures.
