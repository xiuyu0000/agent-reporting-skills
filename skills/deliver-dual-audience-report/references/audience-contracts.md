# Audience contracts

Use one validated `review-document/1` to generate two complete but distinct
views. Keep their identities, facts, decisions, constraints, block state, and
important uncertainty aligned. Never use one generated view as the factual
source for the other.

## Contents

- [Agent Markdown](#agent-markdown)
- [Approval HTML](#approval-html)
  - [Choose the carrier before writing the prose](#choose-the-carrier-before-writing-the-prose)
  - [Bind every term the reviewer cannot be assumed to know](#bind-every-term-the-reviewer-cannot-be-assumed-to-know)
  - [Write a flow's two required strings for a reader](#write-a-flows-two-required-strings-for-a-reader)
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
and T0 start compact while remaining expandable.

Write every sentence for a reader starting from zero context, in the plainest
language that stays accurate. These rules are mandatory, not stylistic.

### Choose the carrier before writing the prose

Name the relationship a block expresses, then pick its carrier. Prose is the
carrier of last resort, not the default.

| The block expresses | Carrier | What prose loses |
|---|---|---|
| Three or more ordered actions | `steps` | order stops being visible while the reader judges each step |
| Two or more options compared on two or more criteria, or several items sharing one set of attributes | `table` | the reader cannot scan one criterion across the options |
| A branch, a condition with two or more outcomes, or a dependency chain among three or more named things | `flow` | the reader has to trace the paths to learn that two exist |
| One consequence that must not be missed | `callout` | the warning reads at the same weight as its surroundings |
| Several named things ordered on one axis — weakest to strongest, cheapest to dearest, a share of a whole | `scale` | rank is only implied by reading order, with no axis, direction, or magnitude |
| An exact command, payload, or file excerpt | `code` | exactness is not guaranteed |

A diagram is never required. `steps`, `table` and `callout` are structured
carriers too, and a block whose content is genuinely linear may stay prose.
Choose the lightest carrier that keeps the relationship visible.

A decision block is defective when all three hold: its body contains only
`paragraph` and `list` nodes; its body text runs past 80 display columns of
continuous prose; and it encodes at least one relationship in the table above.
Restructure it before rendering.

If a reviewer must simulate a sequence in their head to judge a block,
restructure it whatever its length.

### Bind every term the reviewer cannot be assumed to know

- Prefer the everyday phrase over the professional term. When a professional
  term is genuinely required, reference it with a glossary term node
  (`termRef`) bound to a glossary entry, so the reviewer gets the hover
  preview and the in-file appendix entry the term links to. A bare
  professional term with no glossary link is a defect.
- `title`, `summary`, `whyTier`, `ask`, `objective`, `scope`, `exclusions`,
  `constraints`, `risks`, `openQuestions`, every `nextActions` field, and a
  flow's `description`, node `label` and edge `label` are plain strings and
  cannot carry a `termRef`. Write them jargon-free. A term
  that needs defining belongs in a block body, `currentState`, a fact, or a
  decision, where a `termRef` is expressible. This matters most in `ask`,
  which is the one sentence the reviewer must answer.
- A `termRef` whose `text` is not the phrase the reviewer would actually use
  defeats the rule.
- The continuation section and the evidence snapshot render inside the
  Approval HTML for the same zero-context human. Write them in reviewer
  language too — never in Agent shorthand, bare identifiers, or untranslated
  tool output.

### Write a flow's two required strings for a reader

A `flow` carries a mandatory `title` and `description`. Write the
`description` as the takeaway the picture supports, not as a description of
the picture. Every node `label` is reader-facing prose, never a block id or an
internal code name: the text alternative is generated from those labels, so an
id there is unreadable twice over. Give an edge a `label` only when the
transition has a condition worth naming, and keep it short — an over-long edge
label is elided in the picture and survives only in the text alternative.

Before delivery, self-check: could a careful person with no prior exposure to
the project read only this file, top to bottom, and understand every block well
enough to decide it? If any block fails that test, rewrite it before rendering.

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
2. Give only the Approval HTML to a zero-context reviewer — no contract, no
   conversation, no Agent Markdown. Ask this fixed set:
   1. In one sentence, what is being decided overall?
   2. For each T2 block, restate the `ask`, then say what happens if the answer
      is yes and what happens if it is no.
   3. Which terms could you not define from this file alone?
   4. Which blocks did you have to read twice?

   Then have them record a decision, export feedback, and explain what is not
   yet authorized. Every unanswered item in 1–2, every term named in 3, and
   every block named in 4 is a contract defect: fix the contract and rerender.
   Reject the view if another report or an external link is required.

   Record in `continuation.validationEvidence` that the set was run. That
   record proves the check happened; it does not prove the file is clear. The
   reviewer's actual answers are the evidence.

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
