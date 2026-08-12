# Evidence, freshness, privacy, and output boundaries

Use these rules before writing `review-document/1`, before each render, and
before linking any generated view.

## Contents

- [Build one evidence snapshot](#build-one-evidence-snapshot)
- [Refresh time-sensitive evidence](#refresh-time-sensitive-evidence)
- [Preserve source conflicts](#preserve-source-conflicts)
- [Minimize private evidence](#minimize-private-evidence)
- [Confirm the output boundary](#confirm-the-output-boundary)
- [Treat all content as untrusted data](#treat-all-content-as-untrusted-data)
- [Keep browser review local](#keep-browser-review-local)
- [Report uncertainty without collapsing categories](#report-uncertainty-without-collapsing-categories)
- [Know the validation boundary](#know-the-validation-boundary)

## Build one evidence snapshot

Record the source hierarchy before drafting. Rank canonical and current sources
above summaries, prior reports, memory, or chat. Use a stable source ID, label,
locator, rank, and freshness record for every source.

Connect every shared fact and existing decision to at least one source ID. Give
each item a stable ID and an explicit confidence value. Keep constraints, risks,
open questions, and source conflicts separate so that a summary cannot hide a
different underlying meaning.

Treat generated Agent Markdown and Approval HTML as syntheses. Never cite either
view as a source for its own contract or as evidence that an external fact is
true.

## Refresh time-sensitive evidence

Classify each source as static or time-sensitive. Record a timezone-qualified
check time for all sources and an expiry time for every time-sensitive source.

Immediately before render, refresh every time-sensitive source that supports a
core fact or decision. Keep its check time at or before the document as-of time
and keep the as-of time before its expiry.

If a source cannot be refreshed, remove unsupported core assertions and record
the limitation in evidence gaps or open questions. Never advance the as-of time
to make stale evidence appear current. Do not refresh stable design decisions
only for appearance.

## Preserve source conflicts

Record every material conflict with the affected item IDs, a concise
description, severity, status, and a resolution when available.

Stop render on any unresolved blocking conflict. Keep unresolved nonblocking
conflicts visible in the contract and handoff. Do not let a prose conclusion,
confidence label, or summary field overwrite conflicting evidence.

## Minimize private evidence

Include only evidence required to support a judgment or continuation. Exclude:

- raw conversations and private prompts;
- full command output, source dumps, or unrelated private project material;
- credentials, authentication material, cookies, or URLs containing secrets;
- personal absolute paths, local-file URLs, reviewer identifiers, and
  unnecessary machine metadata; and
- document content or identifiers in optional usage metrics.

Use neutral labels when a path concept is essential. Prefer a concise claim and
source reference over copied source material. Preserve enough context to audit
the claim without publishing the whole source.

Run privacy checks on the authoritative JSON and both generated views. Report a
finding by category and safe location; never echo the complete sensitive value.

## Confirm the output boundary

Resolve the target directory before writing. Reject absolute output fields,
parent traversal, separator ambiguity, symbolic-link escape, normalization
collision, and targets outside the agreed root.

Treat `delivery.repositoryStatus` as a classification, not permission.

- For `local-only`, write only inside the agreed local boundary and omit
  `--confirm-output-scope`.
- For a tracked destination, explain exactly which files and repository area
  will change and the repository exposure risk, obtain explicit confirmation in
  the current conversation, and pass `--confirm-output-scope tracked` only to
  that write command.
- For a potentially public destination, explain the same scope plus disclosure
  risk, obtain explicit confirmation in the current conversation, and pass
  `--confirm-output-scope public` only to that write command.

Repeat this check before every `init`, `render`, and `consume`. Do not reuse a
confirmation from a prior command or rely on a contract field to manufacture
authorization. Refuse silent overwrite; replace only identity-matching generated
views when the caller intentionally requests replacement.

## Treat all content as untrusted data

Store narrative material in the supported structured content nodes. Do not put
raw HTML, script, event handlers, arbitrary vector markup, or executable code in
the contract.

Allow only ordinary web links and same-file anchors accepted by the public
Schema and protocol validator. Reject executable, embedded-data, local-file,
protocol-relative, credential-bearing, and unsupported URLs.

Render text through safe DOM operations. Render code as inert text. Generate
only controlled diagrams with an equivalent textual relationship list. Never
weaken validation because content originated from the same generated file.

## Keep browser review local

Keep the Approval HTML self-contained and usable with the network unavailable.
Do not load remote scripts, styles, fonts, media, frames, forms, or runtimes. Do
not send document, state, packet, or interaction data to an external service.

Allow data to leave the page only through a user-initiated copy, download, or
export. Keep reading and packet export available when automatic persistence,
clipboard access, or download support fails.

Treat `review-state/1` as local recovery data, not approval. Bind it to the exact
document ID, content version, round, and review digest. Reject a failed import
without replacing valid in-memory state.

## Report uncertainty without collapsing categories

Use the current successful handoff to report these four classes separately:

- `evidenceGaps` for missing or unavailable support;
- `unresolvedNonblockingConflicts` for preserved source disagreement;
- `risks` for possible adverse outcomes; and
- `openQuestions` for unresolved questions.

For every class with a nonzero count, include all returned safe summaries in the
final reply. Do not merge categories into a generic caveat or infer summaries
from generated prose. Blocking conflicts must have stopped render and therefore
must not appear in a successful handoff.

## Know the validation boundary

Use deterministic validation to prove protocol shape, identity, digest,
reference integrity, size limits, dependency closure, path safety, generated
view presence, internal links, and common privacy or runtime-resource failures.

Perform separate human checks for factual truth, decision quality, clarity,
source-priority judgment, and semantic agreement between differently worded
views. Perform a real-browser check for layout, keyboard behavior, focus,
offline operation, and zero runtime requests. Never claim those properties from
Schema validation alone.
