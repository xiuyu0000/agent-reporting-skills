# Approval writing examples

Worked before/after pairs for the mandatory Approval HTML rules. Each pair
shows the prose an Agent writes by default, then the structured node the rule
requires. Read this while writing block bodies, not after rendering.

Every "after" below is the JSON that goes into `blocks[].body`. The renderer
builds the DOM; never hand-write markup.

## Contents

- [Ordered actions become steps](#ordered-actions-become-steps)
- [Compared options become a table](#compared-options-become-a-table)
- [A branch becomes a flow](#a-branch-becomes-a-flow)
- [An ordered ladder becomes a scale](#an-ordered-ladder-becomes-a-scale)
- [A single consequence becomes a callout](#a-single-consequence-becomes-a-callout)
- [A professional term becomes a termRef](#a-professional-term-becomes-a-termref)
- [Defects to recognise](#defects-to-recognise)

## Ordered actions become steps

**Before.** Four ordered actions buried in one paragraph; the reader has to
rebuild the order before judging any of it.

> First we take a snapshot of the current index, then we run the importer in
> dry-run mode and compare counts, and assuming they match we run it for real,
> after which we delete the snapshot once the nightly job has gone green twice.

**After.**

```json
{
  "type": "steps",
  "items": [
    { "title": "Snapshot the current index",
      "content": [{ "type": "paragraph", "content": [
        { "type": "text", "text": "Keeps a restore point while the import runs." }]}]},
    { "title": "Run the importer in dry-run mode",
      "content": [{ "type": "paragraph", "content": [
        { "type": "text", "text": "Compare the reported record count with the snapshot count." }]}]},
    { "title": "Run the importer for real",
      "content": [{ "type": "paragraph", "content": [
        { "type": "text", "text": "Only when the two counts match exactly." }]}]},
    { "title": "Delete the snapshot",
      "content": [{ "type": "paragraph", "content": [
        { "type": "text", "text": "After the nightly job has passed twice." }]}]}
  ]
}
```

Note what changed besides the shape: each step now says *why*, so the reviewer
can judge a step instead of only reading it.

## Compared options become a table

**Before.** Two options across three criteria, in prose. The reader cannot
scan one criterion across both.

> Option A is cheaper to run and we could ship it this month, but it will not
> survive a second region. Option B costs more and needs about six weeks, but
> it is region-ready from day one and we would not have to revisit it.

**After.**

```json
{
  "type": "table",
  "headers": [
    [{ "type": "text", "text": "Criterion" }],
    [{ "type": "text", "text": "Option A: ship now" }],
    [{ "type": "text", "text": "Option B: build region-ready" }]
  ],
  "rows": [
    [[{ "type": "text", "text": "Time to ship" }],
     [{ "type": "text", "text": "This month" }],
     [{ "type": "text", "text": "About six weeks" }]],
    [[{ "type": "text", "text": "Running cost" }],
     [{ "type": "text", "text": "Lower" }],
     [{ "type": "text", "text": "Higher" }]],
    [[{ "type": "text", "text": "Second region" }],
     [{ "type": "text", "text": "Needs rebuilding" }],
     [{ "type": "text", "text": "Works unchanged" }]]
  ]
}
```

State the recommendation in the block's prose or `ask`, and name the option by
the same label used in the header, so the reviewer can connect them. Every cell
needs real text: `text` is a non-empty string, so name the corner cell rather
than leaving it blank.

## A branch becomes a flow

**Before.** A condition with two outcomes. Prose makes the reader trace the
paths to discover that two exist.

> Changes go through review unless they are documentation-only, in which case
> they merge straight away; reviewed changes that fail the gate go back to the
> author, and ones that pass merge.

**After.**

```json
{
  "type": "flow",
  "title": "How a change reaches the main branch",
  "description": "Documentation-only changes merge straight away; everything else must pass review and the automated checks first.",
  "nodes": [
    { "id": "open", "label": "Change opened", "kind": "start" },
    { "id": "docs", "label": "Documentation only?", "kind": "decision" },
    { "id": "review", "label": "Reviewed by a maintainer" },
    { "id": "author", "label": "Back to the author" },
    { "id": "merged", "label": "Merged to main", "kind": "end" }
  ],
  "edges": [
    { "from": "open", "to": "docs" },
    { "from": "docs", "to": "merged", "kind": "yes" },
    { "from": "docs", "to": "review", "kind": "no" },
    { "from": "review", "to": "merged", "label": "checks pass", "kind": "yes" },
    { "from": "review", "to": "author", "label": "checks fail", "kind": "no" },
    { "from": "author", "to": "review", "label": "resubmitted" }
  ]
}
```

Four things make this readable: `description` states the takeaway rather than
describing the picture; every `label` is a phrase a newcomer understands, with
no professional term in it, because a flow's strings cannot carry a `termRef`;
each edge names a short condition, not a sentence; and `kind` marks the start,
the branch and the end so the renderer can shape them and say so in the text
alternative.

## An ordered ladder becomes a scale

**Before.** Six things ranked weakest to strongest, as a table. Row order is the
only clue that the ordering means anything, and nothing says which end is which.

> Spoken agreements bind least, then a memory file, then prompt text, then a
> template, then a schema with a validator, and a blocking check binds most.

**After.**

```json
{
  "type": "scale",
  "title": "How strongly each carrier binds a rule",
  "description": "A rule survives only as well as the carrier it sits on.",
  "axis": { "lowLabel": "weakest", "highLabel": "strongest" },
  "items": [
    { "label": "Spoken agreement", "position": 5, "display": "lowest" },
    { "label": "Memory file", "position": 18, "display": "low" },
    { "label": "Prompt text", "position": 38, "display": "probabilistic" },
    { "label": "Template or checklist", "position": 58, "display": "medium" },
    { "label": "Schema plus validator", "position": 82, "display": "near-certain" },
    {
      "label": "Blocking check",
      "position": 97,
      "display": "deterministic",
      "note": [{ "type": "text", "text": "It cannot merge until the check passes." }]
    }
  ]
}
```

`position` is a 0-100 integer and carries the magnitude; `display` is the words
the reviewer reads, so write it yourself rather than leaving a bare number. The
renderer prints every label and value as real text beside the bar, so nothing
depends on bar length or colour.

## A single consequence becomes a callout

**Before.** The one irreversible fact is the third sentence of a paragraph and
reads at the same weight as everything around it.

> We will migrate the accounts table overnight. The job takes roughly four
> hours. Once it starts there is no rollback, because the source rows are
> rewritten in place. We will post progress in the usual channel.

**After.** Keep the timing in prose and lift the consequence out.

```json
{
  "type": "callout",
  "tone": "warning",
  "title": "No rollback once the job starts",
  "content": [{ "type": "paragraph", "content": [
    { "type": "text", "text": "The migration rewrites the source rows in place, so it cannot be undone. Approving this block approves that." }]}]
}
```

## A professional term becomes a termRef

**Before.** A bare professional term. This is a defect, not a style choice.

> The change is blocked until the gate goes green.

**After.** Add the glossary entry, reference it from the body, and keep the
`ask` jargon-free — `ask` is a plain string and cannot carry a `termRef`.

```json
{
  "glossary": [
    { "id": "G-004", "term": "gate",
      "definition": "A set of automated checks that runs on every change. A change cannot merge until all of them pass; nobody can waive them." }
  ],
  "body": [
    { "type": "paragraph", "content": [
      { "type": "text", "text": "The change waits until the " },
      { "type": "termRef", "glossaryId": "G-004" },
      { "type": "text", "text": " passes." }]}
  ],
  "ask": "Do you accept that this change cannot ship until all automated checks pass?"
}
```

## Defects to recognise

Each of these is a rule violation to fix before rendering, not a preference.

| Defect | Why it fails | Fix |
|---|---|---|
| A professional term with no glossary link | the reviewer has no way to look it up in the file | add a glossary entry and a `termRef` |
| A node label like `B003` or `svc-idx-2` | the text alternative is generated from labels, so an id is unreadable twice | use a reader-facing phrase |
| A `flow` `description` that describes the picture | wastes the reader's only prose gloss on the diagram | state the takeaway instead |
| A sequence left in prose | the reviewer has to rebuild the order before judging it | `steps` |
| A bare identifier in `ask`, `summary` or `whyTier` | those fields are plain strings; the reviewer meets the jargon with no way to resolve it | rewrite them jargon-free and move the term into a body |
| Agent shorthand in `currentState` or the evidence snapshot | they render for the same zero-context human as the blocks | rewrite in reviewer language |
| A diagram added to a linear block to look thorough | no rule requires a picture; it adds reading cost for nothing | leave it as prose |
