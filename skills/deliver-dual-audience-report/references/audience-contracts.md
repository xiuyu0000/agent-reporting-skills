# Audience contracts

## Shared contract

Both artifacts must agree on the title, as-of time, core facts, decisions,
constraints, and important uncertainty. They may use different order, detail,
examples, and wording.

## Agent-facing Markdown

Write for a capable Agent that must continue the work without re-discovering
the state. Include:

1. objective, scope, exclusions, language, and as-of time;
2. source hierarchy and conflict-resolution rule;
3. precise current state, state model, interfaces, commands, or pseudocode;
4. decisions and reasons, including rejected alternatives when relevant;
5. constraints, risks, blockers, open questions, and next actions;
6. validation evidence and known evidence gaps; and
7. the statement: “This document is a synthesis, not a source of truth.”

Prefer exact nouns and stable identifiers over narrative flourish. Do not copy
private raw conversations or complete command output.

## Human-facing HTML

Write for a reader with no background. Include:

1. an immediately visible Executive Summary with the conclusion and importance;
2. a plain-language explanation of what happened and why;
3. impact, decisions, alternatives, tradeoffs, and the recommended next step;
4. uncertainty placed next to the claim it qualifies;
5. a source/evidence section and a linked glossary for necessary terminology;
6. semantic headings, keyboard-visible focus, a skip link, and one `<main>`;
7. responsive layout with no horizontal scrolling at narrow width; and
8. no external scripts, stylesheets, fonts, images, iframes, or form actions.

Use diagrams only when they clarify a relationship that prose would make hard
to follow. CSS-only flows and timelines are preferred for portability.

## Reader-isolation checks

After drafting, use a fresh reader when risk or complexity warrants it:

- Give only the Agent document to a new Agent and ask what it would do next,
  which facts it trusts, and what remains unknown.
- Give only the HTML to a zero-context reader and ask for the conclusion,
  reason, impact, and next step.

Any answer that depends on hidden conversation context exposes a document gap.
