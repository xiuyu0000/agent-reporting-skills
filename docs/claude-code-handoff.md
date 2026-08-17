# Claude Code handoff: `deliver-dual-audience-report` v0.2

This is the portable operational handoff for continuing validation after the
v0.2 release candidate. It is detailed enough for Claude Code to work without
hidden chat context. Since 2026-08-17 the planning sources it summarizes are
tracked alongside it under [`docs/`](README.md), so read them directly when you
need requirement, design, or task detail. It is not permission to publish, tag,
create a GitHub Release, disclose a pilot, or operate an external system.

## 1. Exact baseline and authority

### Candidate snapshot

| Item | Verified value |
|---|---|
| Candidate branch | `codex/v0.2.0` |
| Candidate integration SHA | `dae53e5b76e6507592b37c1a241e7ad6c6e22905` |
| Release implementation commit | `0b8e14be96ab57213b20e243134b9f9b1180c67a` |
| Release PR | [#60](https://github.com/xiuyu0000/agent-reporting-skills/pull/60), merged |
| Release CI | [run 31693584641](https://github.com/xiuyu0000/agent-reporting-skills/actions/runs/31693584641), Node/Chromium/WebKit/Firefox smoke green |
| Candidate ZIP | `dist/deliver-dual-audience-report-v0.2.0.zip` |
| ZIP size / SHA-256 | `952704` bytes / `ae207e27643390b2b02ff7e8bc56cd49fe7031b1e71a9678fc4b2384f2290b59` |
| Manifest SHA-256 | `9d520f3d4c50a24e1d9303109f075775cdd3547b4df5c14858c4a00fd458eb85` |
| Runtime | Node `>=24 <25` |
| v0.2 tag / GitHub Release | Not created; requires separate user authorization |

`dae53e5b76e6507592b37c1a241e7ad6c6e22905` is the immutable release-artifact
baseline, not a requirement that every later documentation worktree have that
exact `HEAD`. This handoff may itself be committed as a descendant. Use an
isolated v0.2 worktree where that baseline is an ancestor, inspect the diff from
it, and stop if a source or release-artifact change makes the verified ZIP no
longer match the values above. The root `main` branch is an older v0.1 line and
must not be used to run a v0.2 pilot. Refresh remote branch, PR, CI, issues,
milestones, release metadata, and worktree state before claiming any value
above is current.

### Repository-clone handoff versus release ZIP

`AGENTS.md`, `CLAUDE.md`, and this handoff are portable within a repository
clone/worktree. They are intentionally **not** part of the v0.2 ZIP. The ZIP
contains exactly the installed Skill runtime and its 11 release files. For a
real pilot, use the clone only to read the contract and verify the candidate;
use the verified, privately extracted ZIP for every `init`, `render`,
`validate`, `consume`, and `record-usage` invocation.

The v0.1 rollback baseline is historical only: tag
`03fc1185aee022e6bc08c596bcb5dfc8eecfb637` and its asset have SHA-256
`3f7f22465c26b8eb88776ce5dcd5c7863c0763cb855464a463b0b7f5fa4f855b`.
Never convert v0.2 input into the legacy static-report contract.

### Authority order

Resolve conflicts in this order:

1. A fresh, user-authorized fact or explicit current instruction.
2. Current candidate code, public Skill files, schemas, and executed validation.
3. The tracked planning sources: [`docs/spec.md`](spec.md),
   [`docs/design.md`](design.md), and [`docs/task.md`](task.md).
4. This handoff, which is an operational snapshot.
5. Generic tool knowledge or inferred convention.

On 2026-08-17 the user decided that these planning sources are tracked with the
repository instead of staying locally ignored. Their current SHA-256 values are:

| Source | SHA-256 | Value at 2026-08-17 handoff time |
|---|---|---|
| `spec.md` | `6f54504182d88388f6bfd71e487a2cdf741cac9c490a858f6591c3c7af9cdcc1` | `677f56b36ff881058fa9054786a095a15780efe105f9fbbe992abc34a45cfbb5` |
| `design.md` | `6d6916d7af9d49d317c8138c243cd00ca5d66e89a8196aac8a25a77b13aef61b` | `4c97ab3dd4ced8f3e96c514375ef9b799fe4351facc4fb724fe3dc0e8c058b79` |
| `task.md` | `cf028b4c8a3f7587ad46d1c3c036029d9544013c265f7cc01fd4ef52392a3a5b` | `3287e29184d422f9a059bce9a2cdbbce4efacf58a7d971f1eec0cf61871f46df` |

The digest change is documentation consolidation only — status metadata,
tracking rules, cross-references, and refreshed digests. No requirement clause,
design decision, acceptance criterion, or recorded completion evidence changed,
so every contract value in this handoff still holds. Read the tracked files
directly rather than reconstructing them from memory, and verify a digest before
treating a planning source as current.

`docs/调研/` remains local, private, and `.gitignore`-excluded. It must never be
committed, and its body must never be copied into a tracked file; the tracked
documents keep only provenance references to it. This handoff preserves the
contract needed for PIL-001 and MET-001.

## 2. Research basis and accepted product decisions

The research replaced a workflow where a reviewer read a static report,
switched to an external note surface, then manually reconstructed a next-Agent
prompt. It identified three connected failures: attention dilution, working
memory overload, and a broken feedback loop.

The accepted answer is a single-fact approval workflow:

- one `review-document/1` generates precise Agent Markdown and self-contained,
  interactive Approval HTML;
- one primary reviewer records decisions in place;
- a structured packet feeds the next Agent round without inventing a new
  interpretation;
- partial decisions, reopening, uncertainty, conflicts, and evidence remain
  visible across rounds.

| Research source family | Accepted use | Explicit exclusion |
|---|---|---|
| Agent research/execution report v1.2 | Problem model, decision blocks, triage, actions, packets, rounds | Not a source of live business facts |
| Approved document-governance r3 | Approval view is self-contained; static human narrative is no longer default | No directory/index governance in the Skill |
| Approved approval-interaction r3 | In-place decisions, recovery, reopening, finalization | No historical implementation details as public wire |
| Archived r1/r2 rounds | Migration provenance | No obsolete actions in new output |
| Human research report | Cognitive-load and closed-loop rationale | Does not define current behavior |

The current actions are exactly `PASS`, `EDIT`, `TOPIC`, and `HOLD`.
Historical `TRIM`/`EXPAND` only migrate through the explicit legacy path to
`EDIT`. The old static-report contract is rejected, not silently adapted.

## 3. Requirement and architecture contract

### Trigger boundary

Use the Skill only when all are true:

1. One primary human reviewer has an explicit approval, review, or
   item-by-item feedback goal.
2. The initial proposal naturally has at least four independently decidable
   items.
3. The task needs both Agent continuation context and a self-contained human
   approval interface.

Do not use it for parallel/multiple reviewers, fewer than four natural
decisions, exploratory reading, a single-artifact report, chat-only work, or a
code-only task without a separate approval deliverable. Never pad or split to
force eligibility.

### Core flow

```text
verified sources
  -> review-document/1 (sole fact and decision authority)
  -> render
     -> Agent Markdown (continuation)
     -> Approval HTML (single-reviewer decisions)
  -> review-packet/1 (sole feedback authority)
  -> authored candidate / derived topic documents
  -> validate transition + consume
  -> fresh revision or finalization artifacts + current handoff
```

`review-state/1` is only a resumable browser overlay. Packet Markdown is a
readable carrier for one packet JSON payload, not another packet grammar.

| Layer | Responsibility | Forbidden shortcut |
|---|---|---|
| Protocol/schema | Shape, identity, canonicalization, digest, graph invariants, migration | Hand-rolled JSON assumptions |
| Transition | Eligibility, reopening, impact, topic idempotency, finalization | Treating past approval as permanent after dependency change |
| Generator/validation | Exact Agent/Approval bytes, privacy, CSP, delivery checks, handoff | Hand-editing generated files or copying validation logic |
| CLI I/O | Safe roots, transactions, recovery, confirmation scope | Direct output writes or path/symlink shortcuts |
| Workbench/assembly | Review interaction and five public CLI commands | Undocumented entry points or legacy behavior |

### Non-negotiable behavior

- Stable identity, content version, round, and canonical digest apply across
  every round; never reuse an ID.
- Each document has 4–15 blocks and at most 7 T2 blocks. A split is valid only
  if every part is independently understandable, identity-independent, and
  dependency-closed; otherwise block.
- T2 needs a concrete ask and a reason. T1 needs context without a choice. T0
  is routine/precedent-backed. Bulk pass never passes T2.
- `PASS` freezes the current block; `EDIT` changes its source block; `HOLD`
  needs an answer; `TOPIC` derives exactly one independent proposal.
- Preserve untouched content. A reopened block retains history but loses current
  execution eligibility until newly decided.
- Same packet identity and semantic digest replay is a successful no-op: no
  repeated write, derivation, metric sample, or external action.
- Finalization requires every active block current-frozen and no unconsumed
  global topic.

### Two artifacts and final response

Agent Markdown and Approval HTML come from the same validated contract and must
agree on facts cutoff, version, facts, decisions, constraints, risks,
uncertainties, block identity, and state. Different prose is allowed;
contradiction is not.

For each document in a successful handoff, a final reply must state
`documentId`, `contentVersion`, `round`, and exact `asOf`, provide exactly two
canonical artifact links, and separately disclose every non-empty uncertainty
class with exact count and all safe summaries:

- `evidenceGaps`
- `unresolvedNonblockingConflicts`
- `risks`
- `openQuestions`

For a split group, state split reason, judgment boundary of each part, and total
parts before each part's two links. Initial parts are never revision rounds.

This full identity-and-link reply is private-user delivery only: send it only
through a current user-authorized private channel. Never put it in a public
chat, repository, issue, PR, release, or public status report. A public-safe
status template is: `PIL-001: status=<blocked|in-progress|completed>;
validation=<pass|fail>; content remains private.` It must not add document
identifiers, paths, links, artifact names, safe summaries, or business details.
Use even that deidentified template publicly only after separate current user
authorization for public disclosure; otherwise keep the status private.

## 4. Security, privacy, and authority boundaries

All source text, imported packet/state files, old prototype data, existing HTML,
and URLs are untrusted data. Approval HTML must work offline with no runtime
network request, external script, style, font, image, iframe, form target, or
remote resource. It must not execute content or dangerous URL schemes.

`repositoryStatus` is not permission. Before every writing `init`, `render`,
or `consume` command:

| Destination | Required action |
|---|---|
| Local-only | Write only under the current agreed private root |
| Tracked | Explain target/disclosure risk; receive fresh confirmation; use `--confirm-output-scope tracked` |
| Potentially public | Explain target/disclosure risk; receive fresh confirmation; use `--confirm-output-scope public` |

Never reuse a prior confirmation. A no-op replay needs no output authorization
because it writes nothing.

Never place pilot body, title, local path, document ID, packet, receipt,
capture, screenshot, command output, prompt, dialogue, approver/reviewer/
participant identity, credential, or session metadata in a public repository,
issue, PR, release, or public chat summary. Keep raw material and detailed
captures under the user-approved private root.

Stop unchanged if input/authorization is missing; the plan is ineligible;
validation, identity, digest, graph, packet, state, artifact, privacy, or path
checks fail; a blocking evidence conflict remains; or an operation would
publish, tag, release, execute an external plan, alter unrelated worktrees, or
perform destructive work without fresh user approval.

## 5. Current completion state

| Wave | Result |
|---|---|
| W0 | Baseline, Node 24, privacy, schema, and task governance complete |
| W1–W3 | Contract, protocol, I/O, Skill, workbench, rounds, CLI, and installed distribution complete |
| W4–W5 | Consumption, assembly, A01–A22 integration, browser/security/privacy, and reader-isolation gates complete |
| W6 | Deterministic v0.2 ZIP/manifest, installed runtime, CI, rollback proof, and exact-SHA reviews complete |

### Historical task sequence and remaining dependency

The implementation sequence was deliberately ordered as W0 governance and
schema baseline, W1–W3 protocol/CLI/Skill/workbench construction, W4–W5
consume/assembly/integration proof, and W6 release packaging. Those completed
waves are implementation evidence, not permission to invent a pilot.

The only remaining sequence is strict: a genuine user-authorized **PIL-001**
case first, then **MET-001** only after three to five independently eligible
real cases exist. A fixture, a replay no-op, a synthetic reader test, or a green
CI run cannot substitute for either step. Keep #61 blocked until the first real
closure and #62 deferred until the sample threshold and measurement contract
are actually met.

Representative final candidate evidence was unit `502/502`, release E2E `7/7`,
browser `88` pass plus `2` designed skips, and coverage statements/branches/
functions/lines of `91.53%`/`85.47%`/`97.30%`/`94.75%`. Generated-artifact,
installed-skill, legacy-interface, privacy, distribution, and pinned Skill
validation gates passed. Refresh live state before calling these current.

| Remaining task | GitHub issue | State | Completion proof |
|---|---|---|---|
| PIL-001: one genuine business approval loop | [#61](https://github.com/xiuyu0000/agent-reporting-skills/issues/61) | blocked | Genuine generate→approve→packet→consume→revision/finalization, both artifacts, and content-free burden evidence |
| MET-001: 3–5 real-case metrics | [#62](https://github.com/xiuyu0000/agent-reporting-skills/issues/62) | deferred | Three to five eligible cases meet the measurement contract, or report `尚未验证` honestly |

W0–W6 milestones are closed. W7 stays open while #61 and #62 are open. Green
fixtures cannot close either issue.

## 6. PIL-001 exact runbook

### 6.1 Entry gate

Before Claude Code, another agent, or any tool reads actual proposal, packet,
or generated-artifact content, obtain current explicit authorization for the
named execution platform and private channel to process that material. If the
platform can upload it to a hosted service, the authorization must explicitly
cover that disclosure. Then obtain all four of the following through that
authorized private channel or a user-operated local file picker:

1. One exact local path to a genuine non-demo proposal, plus explicit
   authorization to read that path privately. Request only this minimum path
   metadata, never the proposal body. The user may provide it through the
   already-authorized private channel or file picker; do not echo it into a
   public, unapproved, or retained chat, a terminal transcript, a commit, or an
   issue. Read the body and any title only from the authorized private file.
2. A real approval objective and one primary approver.
3. Explicit authorization to write only under one named private output root.
4. Explicit authorization to write only under one separately named private
   runtime/extraction root for the verified ZIP.

If CLI-backed pilot/MET metrics will be appended **or summarized**, obtain one
additional, separate authorization for the local state directory
`~/.codex/state/deliver-dual-audience-report/usage`. Output-root authorization
does not authorize that state directory. Without this additional authorization,
do not invoke any `record-usage` operation and do not claim CLI-backed metric
evidence.

Confirm it is not research-about-this-workflow, a fixture, coordinator-invented
content, or multi-reviewer work. The proposal must naturally contain at least
four naturally independent decision items. A primary approver is not permission to share
the material with any other person or service. If the user cannot authorize a
specific platform/channel and safe minimum-metadata transfer, stop rather than
asking for a pasted business body or inventing a path/title.

### 6.2 Preflight

Run in a clean, isolated v0.2 worktree. The baseline may be an ancestor of the
documentation worktree; it need not be its exact `HEAD`:

```bash
set -euo pipefail
test -z "$(git status --porcelain)" || { echo "Use a clean isolated worktree." >&2; exit 1; }
git fetch origin --prune
git merge-base --is-ancestor dae53e5b76e6507592b37c1a241e7ad6c6e22905 HEAD
git diff --name-only dae53e5b76e6507592b37c1a241e7ad6c6e22905..HEAD
node -e 'const major = Number(process.versions.node.split(".")[0]); if (major !== 24) { console.error("Node 24 is required."); process.exit(1); }'
test ! -e node_modules || { echo "Use a new worktree with no existing node_modules." >&2; exit 1; }
npm ci
npm run verify:dist
printf '%s  %s\n' \
  'ae207e27643390b2b02ff7e8bc56cd49fe7031b1e71a9678fc4b2384f2290b59' 'dist/deliver-dual-audience-report-v0.2.0.zip' \
  '9d520f3d4c50a24e1d9303109f075775cdd3547b4df5c14858c4a00fd458eb85' 'dist/deliver-dual-audience-report-v0.2.0.manifest.json' \
  | shasum -a 256 -c -
```

Stop before any npm or CLI mutation if the Node 24 gate fails. Stop if the
baseline is not an ancestor, the diff contains unreviewed source/release drift,
the ZIP or manifest digest differs from section 1, or the worktree boundary
drifts. Run this only in a new dedicated worktree with no existing
`node_modules`: `npm ci` removes and recreates that ignored directory. Do not
delete or replace an existing dependency directory without separate explicit
authorization. `npm ci` is dependency setup only, not publication or output
authorization.

After `verify:dist` and both SHA-256 values match, extract the ZIP only into a
separately authorized private runtime root that is new and empty. Do not merge
an archive into an existing runtime directory. Its expected top-level directory
is `deliver-dual-audience-report`; bind the pilot runtime once:

```bash
set -euo pipefail
node -e 'const fs = require("node:fs"); const path = require("node:path"); const raw = process.argv[1]; const root = typeof raw === "string" ? path.resolve(raw) : ""; if (typeof raw !== "string" || !path.isAbsolute(raw) || raw !== root) { console.error("Runtime root must be absolute and lexical-canonical."); process.exit(1); } const parent = path.dirname(root); const stat = fs.lstatSync(parent); let rootStatus; try { rootStatus = fs.lstatSync(root); } catch (error) { if (error === null || typeof error !== "object" || error.code !== "ENOENT") throw error; } if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(parent) !== parent || rootStatus !== undefined) { console.error("Runtime parent must be canonical and root must be new."); process.exit(1); }' '<private-runtime-root>'
unzip -q dist/deliver-dual-audience-report-v0.2.0.zip -d '<private-runtime-root>'
node '<private-runtime-root>/deliver-dual-audience-report/scripts/review-delivery.mjs' --help
```

Do not substitute `skills/.../review-delivery.mjs` from the repository source
tree for the extracted path during PIL-001. The source worktree verifies the
candidate; the extracted release ZIP is the only pilot runtime. Every command
below repeats the full path deliberately: Claude Code terminal calls may use
separate shells, so no shell variable persists between steps.

All quoted placeholders below are one literal, user-authorized argument. Replace
only the placeholder text; never interpolate shell expressions, concatenate an
untrusted command string, or use `eval`. If any permitted dynamic value (path,
title, or derived value) cannot be passed as one safely quoted shell argument,
use the terminal tool's argument-array interface instead. Brackets around
optional `--derived` arguments are prose; omit the brackets when not using an
option.

Every filesystem placeholder in this runbook is an already-authorized,
absolute, canonical, non-symlink path. Do not derive any path from the terminal
working directory. This includes the runtime root, output root, proposal,
document, packet, candidate, derived document, and metrics input. Stop if a
path cannot be supplied with those properties.

### 6.3 Author and validate the first document

Use the public schemas for exact fields. Keep the proposal and all delivery
outputs outside the repository under the approved private output root. The ZIP
runtime stays under its separately authorized private runtime root, and the
usage store is separate again:

```text
node '<private-runtime-root>/deliver-dual-audience-report/scripts/review-delivery.mjs' init --output-dir '<private-output-root>' --base-name '<safe-base-name>' --title '<user-approved-title>' --language '<bcp47>' --ui-locale '<zh-CN|en>' --as-of '<iso8601-with-timezone>'
```

`init` only creates a draft skeleton. Populate `review-document/1` from verified
sources, state source priority and facts cutoff, preserve conflicts and evidence
gaps, and set it to `in-review` only when semantically complete. `--title` is
private artifact content: derive a user-approved minimal or deidentified title
locally from the authorized proposal. It may appear only in the authorized
private local command trace; do not request it in ordinary chat or repeat it in
terminal output or an unapproved/persisted transcript. If the execution tool
cannot pass it through an authorized private argument interface, stop.

```text
node '<private-runtime-root>/deliver-dual-audience-report/scripts/review-delivery.mjs' render --document '<review-document.json>'
node '<private-runtime-root>/deliver-dual-audience-report/scripts/review-delivery.mjs' validate delivery --document '<review-document.json>'
```

For a valid split group, use the public batch interface. Do not use
`--replace-generated` unless replacement is intentional and generator identity
checks succeed.

### 6.4 Human and reader checks

Open Approval HTML offline in a real browser. Check desktop and narrow layout,
keyboard-only decisions, visible focus, accessible labels, zero network,
meaningful text alternatives, and safe display of untrusted text. Perform a
human semantic comparison of contract, Agent Markdown, and Approval HTML.

First complete the local browser and human semantic checks. Give only Agent
Markdown to a fresh continuation Agent and only Approval HTML to a zero-context
reviewer **only** after the user explicitly authorizes private disclosure to
each named recipient, platform, and channel (including Claude Code or another
hosted model if it could upload the material). These are read-only validation
recipients, not additional approvers. Without that authorization, do not send
the material, do not leak expected answers, and keep reader-isolation/PIL
validation incomplete rather than substituting a fixture.

Creating Approval HTML under the private output root does not authorize sending
it to the primary approver. The user must either deliver it personally or
explicitly authorize a named approver's private channel. Do not send the file
automatically; the primary approver remains the sole decision-maker.

### 6.5 Packet, candidate, and consume

The reviewer exports `review-packet/1` JSON or deterministic packet Markdown.
It is the only feedback authority. Author the next candidate and any
dependency-closed TOPIC documents before writing:

```text
node '<private-runtime-root>/deliver-dual-audience-report/scripts/review-delivery.mjs' validate transition --current '<current-document.json>' --packet '<packet.json-or-md>' --candidate '<candidate-document.json>' [--derived '<topic-id>=<derived-document.json>' ...]
node '<private-runtime-root>/deliver-dual-audience-report/scripts/review-delivery.mjs' consume --current '<current-document.json>' --packet '<packet.json-or-md>' --candidate '<candidate-document.json>' [--derived '<topic-id>=<derived-document.json>' ...] --output-dir '<private-output-root>/<fresh-round-dir>'
```

`consume` validates and atomically publishes only after all checks pass. It does
not decide EDIT, answer HOLD, choose impacts, or execute an approved external
action. Validate the new delivery after an apply; construct the final reply only
from its returned handoff. `<private-output-root>/<fresh-round-dir>` must be a
previously nonexistent, empty destination beneath the user-authorized private
output root; do not precreate it, and never choose a sibling, symlink,
repository path, or another unapproved destination. A replay no-op is not
another pilot case.

### 6.6 Content-free PIL evidence and metric append

Keep a deidentified local PIL closure note under the authorized private output
root. It may say only that the genuine case completed or was blocked, whether
the user confirmed usefulness, whether a packet was consumed, whether the
delivery was revised or finalized, and whether evidence gaps remain. It is not
`record-usage` input and must never be passed to the CLI.

When, and only when, the user has separately authorized the state directory
`~/.codex/state/deliver-dual-audience-report/usage`, create an input file under
the authorized private output root with **exactly** these keys. The values below
are a structurally valid example only; replace every measurement with observed
facts from a real case before appending it. Do not append this example.

<!-- record-usage-pilot-input:start -->
```json
{
  "eligible": true,
  "triggered": true,
  "correct": true,
  "validation": "passed",
  "result": "success",
  "corrections": 0,
  "interruptions": 0,
  "caseKey": "opaque_pilot_case_key_0001",
  "sampleSequence": 1,
  "t0T1DecidedCount": 4,
  "t0T1ActiveReviewMs": 8000,
  "totalActiveReviewMs": 12000,
  "sourceRevisionRounds": 1,
  "closedLoop": true,
  "burdenScore": -1
}
```
<!-- record-usage-pilot-input:end -->

`caseKey` must be an opaque locally generated 16–128-character value using only
`A-Z`, `a-z`, `0-9`, `_`, and `-`; never derive it from a business title,
document ID, path, reviewer, or project. Active review time is counted only
while the review page is visible and a keyboard or pointer interaction occurred
within the preceding 60 seconds. Exclude background, idle, and Agent generation
time. Count source revision rounds only after the initial draft and before
finalization when a successful revision follows EDIT, HOLD, or a source-content
change; exclude replay no-ops and independent TOPIC derivations.

For each new real case, generate a fresh, never-before-used opaque `caseKey` and
choose a `sampleSequence` that is unique among the latest complete records of
every case. When correcting the same case, retain its same opaque `caseKey` and
use a higher sequence. Never reuse the illustrative sequence `1` for multiple
cases or move a sequence backwards: duplicates or a decrease make the CLI
return an empty `尚未验证` summary.

Append through the verified extracted runtime, and retain the one-line JSON
result privately:

```text
node '<private-runtime-root>/deliver-dual-audience-report/scripts/review-delivery.mjs' record-usage append --input '<private-output-root>/content-free-metrics.json'
```

Treat only JSON `{ "status": "recorded" }` as recorded evidence. The command
can return exit 0 with `not-recorded`, so an exit code alone never proves that a
metric exists. On `not-recorded`, preserve the already validated delivery,
record only the authorization/storage blocker in the private closure note, and
do not invent a metric sample or retry to another state location.

Do not include titles, IDs, paths, filenames, business text, prompts, command
output, reviewer identity, credentials, or session data. One validated,
user-confirmed useful case can close PIL-001; it cannot establish long-term
metrics.

## 7. MET-001 measurement runbook

Count only genuine, complete proposal→approval→packet→revision/finalization
loops with every metric field. Exclude fixtures, demos, incomplete work, and
duplicate no-op replays. A record is eligible for the CLI summary only when
`eligible=true`, `triggered=true`, `correct=true`, `validation="passed"`,
`result="success"`, `closedLoop=true`, and `t0T1DecidedCount>0`, in addition to
having every pilot field. At three to five eligible cases, require:

- aggregate T0/T1 active-review milliseconds divided by aggregate decided T0/T1
  blocks below 10 seconds;
- every complete case at most 30 minutes active review time;
- every source proposal at most two revision rounds before finalization;
- median burden score below `0` versus the old flow.

```text
node '<private-runtime-root>/deliver-dual-audience-report/scripts/review-delivery.mjs' record-usage summarize --min-samples 3 --max-samples 5
```

With fewer than three cases, a missing field, or no old-flow comparison, report
exactly `尚未验证`. Never estimate missing data or turn a target into a result.
If state-directory authorization was not granted, report that metric recording
and summarization are not authorized and do not synthesize a summary. A public
summary needs new user authorization and can contain only sample count,
aggregate values, per-case threshold booleans, and conclusion.

## 8. Validation, GitHub, and recovery rules

For documentation-only changes: first make every intended new file visible to
the tracked-tree scanner without staging unrelated work. For this handoff, run
exactly:

```bash
git add -N -- AGENTS.md CLAUDE.md docs/claude-code-handoff.md \
  tests/unit/claude-handoff.test.ts \
  docs/README.md docs/spec.md docs/design.md docs/task.md
```

The four `docs/` planning files joined that list on 2026-08-17 when they became
tracked. Stage only the ones you actually changed. `docs/调研/` is never staged:
it stays `.gitignore`-excluded, and `npm run test:unit -- public-tree` fails if
any path under it becomes tracked.

Inspect the resulting paths, then verify local Markdown links, refresh stated
remote facts, scan changed tracked text for privacy leaks, run
`npm run test:unit -- claude-handoff public-tree` and `git diff --check`, and
obtain an exact-SHA review. Before committing, replace intent-to-add with a
reviewed stage containing exactly those intended paths.

For code or generated assets, run at least:

```bash
npm run build
npm run check:generated
npm run typecheck
npm run lint
npm run test:unit
npm run test:browser
npm run test:e2e
npm run validate:skill
npm run verify:dist
git diff --check
```

Use a dedicated branch/worktree. Do not overwrite the candidate branch. Push or
open a PR only with current user authorization. Do not tag v0.2, create a
GitHub Release, publish a ZIP, close #61/#62, or disclose pilot results without
separate authorization.

| Situation | Required response |
|---|---|
| No named private root | Do not run a writing command; ask for authorization |
| Ineligible proposal | Use a lighter workflow; never pad or split to force the Skill |
| Tracked/public output | Explain exact target, obtain fresh confirmation, use the matching flag |
| Validation failure | Preserve inputs/current state; report stable error; repair responsible source only |
| Packet replay no-op | No new output, derivation, metric case, or external action |
| Candidate/release drift | Stop private handling; rebind baseline first |
| Publication/destructive request | Pause for explicit user approval |

## 9. Required reading by stage

| Stage | Read before acting |
|---|---|
| Any repository operation | [AGENTS.md](../AGENTS.md), this handoff, current Git/worktree state |
| Planning context, scope, or acceptance question | [docs index](README.md), then [spec.md](spec.md), [design.md](design.md), [task.md](task.md) |
| Source collection/output scope | [evidence and privacy](../skills/deliver-dual-audience-report/references/evidence-and-privacy.md) |
| Contract, packet, split, consume | [review protocols](../skills/deliver-dual-audience-report/references/review-protocols.md) and the public schemas |
| Agent/Approval isolation | [audience contracts](../skills/deliver-dual-audience-report/references/audience-contracts.md) |
| Any actual Skill use | [SKILL.md](../skills/deliver-dual-audience-report/SKILL.md) |

The repository entry point is [CLAUDE.md](../CLAUDE.md). Keep this handoff,
`CLAUDE.md`, and `AGENTS.md` synchronized with candidate evidence.
