# Audience contracts

Use one validated `review-document/1` to generate two complete but distinct
views. Keep their identities, facts, decisions, constraints, block state, and
important uncertainty aligned. Never use one generated view as the factual
source for the other.

## Contents

- [Agent Markdown](#agent-markdown)
- [Approval HTML](#approval-html)
- [Shared snapshot boundary](#shared-snapshot-boundary)
- [Reader-isolation checks](#reader-isolation-checks)
- [Delivery handoff](#delivery-handoff)

## Agent Markdown

Write for a capable Agent that receives no hidden conversation context. Include:

1. the objective, scope, exclusions, content language, as-of time, document ID,
   content version, approval round, and status;
2. the source hierarchy and the rule used to resolve or preserve conflicts;
3. the precise current state, shared facts, existing decisions, constraints,
   risks, open questions, evidence gaps, and unresolved conflicts;
4. every decision block in narrative order with its stable ID, tier, dependency,
   current active or frozen status, approval history, and current-round change;
5. T2 rationale and the concrete question the reviewer must answer;
6. next actions with stable action IDs and verification conditions;
7. validation evidence, topic mappings, dependency impacts, and unresolved
   feedback; and
8. a visible statement that the document is an evidence synthesis rather than
   a source of truth.

Prefer stable identifiers, exact conditions, and structured content over prose
that forces the next Agent to infer state. Preserve enough detail to revise a
single touched block without rediscovering the proposal.

Do not present approval or dependency eligibility as permission to operate an
external system. State the remaining execution boundary wherever an approved
action could otherwise look self-authorizing.

## Approval HTML

Write for one human reviewer who receives no Agent Markdown and no prior
conversation. Keep all decision-essential information inside the file.

Preserve the proposal's narrative block order. Default T2 blocks open; let T1
and T0 start compact while remaining expandable. Use a controlled flow only
when it makes a relationship materially easier to judge, and provide
equivalent text.

Write every sentence for a reader starting from zero context, in the plainest
language that stays accurate. These rules are mandatory, not stylistic:

- Prefer the everyday phrase over the professional term. When a professional
  term is genuinely required, reference it with a glossary term node
  (`termRef`) bound to a glossary entry, so the reviewer gets the in-place
  definition, its hover preview, and the appendix entry. A bare professional
  term with no glossary link is a defect.
- The continuation section and the evidence snapshot render inside the
  Approval HTML for the same zero-context human. Write them in reviewer
  language too — never in Agent shorthand, bare identifiers, or untranslated
  tool output.
- Express logic, processes, and multi-step relationships as structured
  content — steps, tables, or a flow with its text equivalent — rather than
  as long prose. If a reviewer must simulate a sequence in their head to
  judge a block, restructure it.
- Before delivery, self-check: could a careful person with no prior exposure
  to the project read only this file, from top to bottom, and understand
  every block well enough to decide it? If any block fails that test,
  rewrite it before rendering.

Support these review behaviors without an external service:

- inspect all blocks and distinguish active, frozen, reopened, and decided
  state without relying on color alone;
- apply, replace, or undo PASS, EDIT, TOPIC, and HOLD decisions;
- require actionable text for EDIT, a title for TOPIC, and a question for HOLD;
- preserve selected source text as an optional quote;
- add, edit, search, and delete decisions, side notes, and global topics;
- bulk-PASS only pending active T0/T1 blocks after a second confirmation;
- export a partial or complete packet at any point;
- export and import resumable state without turning it into approval authority;
- reopen a frozen block while preserving approval history and suspending its
  current eligibility; and
- complete the core flow with a keyboard and visible focus.

Keep the file self-contained. Do not require remote scripts, styles, fonts,
images, frames, forms, or runtime requests. Allow ordinary external links only
as optional further reading initiated by the user.

## Shared snapshot boundary

Generate both views from the same validated document, generator version, and
render transaction. Allow different order, detail, and wording only where their
audience duties differ. Require agreement on:

- document and delivery identity;
- title, language, as-of time, content version, and approval round;
- core facts, decisions, constraints, risks, and uncertainty;
- stable block IDs and active, frozen, changed, or reopened meaning; and
- current approval and lineage state.

Do not expect browser review edits to update the already-generated Agent
Markdown. Treat them as a review overlay until a valid packet is consumed and a
new round regenerates both views.

## Reader-isolation checks

Run both checks after deterministic validation and before delivery:

1. Give only the Agent Markdown to a fresh Agent. Ask it to identify the goal,
   authoritative sources, current state, active and frozen blocks, required
   next actions, and remaining uncertainty. Reject the view if the answer
   depends on hidden chat context.
2. Give only the Approval HTML to a zero-context reviewer. Ask them to explain
   the proposal, decide each T2 block, find supporting evidence and definitions,
   record a decision, export feedback, and explain what is not yet authorized.
   Reject the view if another report or external link is required.

Inspect the Approval HTML in a real browser with the network unavailable. Check
desktop and narrow layouts, keyboard-only use, focus visibility, decision
feedback, and the absence of runtime requests. Perform a separate semantic
comparison because structural checks cannot prove that differently worded
passages agree.

## Delivery handoff

Use only paths returned by the current successful CLI handoff. Link both real
views and state the exact as-of time. Report each non-empty handoff uncertainty
class separately with all safe summaries.

For a split group, explain the reason, total number of parts, and each part's
judgment boundary before listing that part's Agent and Approval links. Treat
each part as an independent approval document, not as a revision round.
