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
| Original release baseline SHA | `dae53e5b76e6507592b37c1a241e7ad6c6e22905` (ancestor gate for §6.2; not the current artifact source) |
| Original release implementation commit | `0b8e14be96ab57213b20e243134b9f9b1180c67a`, PR [#60](https://github.com/xiuyu0000/agent-reporting-skills/pull/60), CI [run 31693584641](https://github.com/xiuyu0000/agent-reporting-skills/actions/runs/31693584641) |
| Current artifact source | W9–W11, W15, W17, W19, then W23 (UI-008/UI-009/CTR-003/SKL-004 approval-clarity work), re-cut by REL-009 on 2026-09-02 |
| Candidate ZIP | `dist/deliver-dual-audience-report-v0.2.0.zip` |
| ZIP size / SHA-256 | `1021851` bytes / `c607212389ff233c0ec69fadc722b235190ac94d11d45cfdb63c92556c1a4b9b` |
| Manifest SHA-256 | `50fecddd6a0f699d3c42fa9793eb567920f1b7c600f179d76a36121ed517cbb3` |
| Runtime | Node `>=24 <25` |
| Protocol surface | `review-document/1` gained optional-only additions in W23 (`scale` node; `kind` on flow nodes and edges). Existing documents are byte-identical and their digests unchanged. The skew is **forward**: a document written by this candidate is **rejected**, never misread, by an older v0.2.0 runtime, whose ZIP carries its own digest-pinned Schema copy. Skill and runtime ship in one ZIP, so mixed-version use is outside the supported path. |
| v0.2 tag / GitHub Release | Not created; requires separate user authorization |

`dae53e5b76e6507592b37c1a241e7ad6c6e22905` is the original release baseline and
the ancestor gate used by §6.2, not a requirement that every later worktree have
that exact `HEAD`. This handoff may itself be committed as a descendant. The
candidate ZIP is no longer that commit's ZIP: on 2026-08-18 the user chose to
re-cut v0.2 rather than open a v0.2.1 line, so the W9 and W10 contract fixes are
in the shipped runtime and REL-004 rebuilt the archive. `952704` bytes /
`ae207e27…2f2290b59` and manifest `9d520f3d…d458eb85` are now historical values
that survive only in the REL-001 and REL-002 completion evidence. Use an isolated
v0.2 worktree where the baseline is an ancestor, inspect the diff from it, and
stop if a source or release-artifact change makes the verified ZIP no longer
match the values above. Since 2026-08-20 the root `main` branch is kept
tree-identical to `codex/v0.2.0` by an `-s ours` sync merge; `codex/v0.2.0`
remains the integration branch and the base for PRs, and a pilot still runs
only from a dedicated clean worktree with the separately extracted ZIP
runtime, never from a casually reused checkout. Refresh remote branch, PR, CI, issues,
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
| `spec.md` | `2459bf72298f12dc6d5938b682737516ba87145de30568847ec286da8279124b` | `677f56b36ff881058fa9054786a095a15780efe105f9fbbe992abc34a45cfbb5` |
| `design.md` | `a6d55c85d4c3e45a955fd7c76da6992647d11708643c99b065989503799eb63b` | `4c97ab3dd4ced8f3e96c514375ef9b799fe4351facc4fb724fe3dc0e8c058b79` |
| `task.md` | `ea5517297ecbc7f1b94a692d9f003c391cee2ab10b232132e1704962b72468c8` | `3287e29184d422f9a059bce9a2cdbbce4efacf58a7d971f1eec0cf61871f46df` |

`spec.md` has changed once since the 2026-08-17 consolidation: on 2026-08-19,
DOC-002 turned the user-approved workbench visual system into contract text
(§1 exception, §7.2 clause, §17.2 convergence row, §18.1 change record) without
adding any product capability. `design.md` has changed twice: on 2026-08-18
DOC-001 corrected DES-017 — the row still claimed the planning sources stay
gitignored and out of CI, which the consolidation had falsified and REL-002 then
turned into an executable CI assertion — and on 2026-08-19 DOC-002 added DES-019
plus the normative §11.8 token list; and on 2026-09-02 W23 added DES-020 with the
§7.3 `scale` node, the optional flow `kind` fields, and the §11.3 term-preview
and flow-layout records. The first two revisions changed no run-time behaviour;
the 2026-09-02 one records behaviour that W23 implemented, and it left §11.8
untouched. `task.md` changes
whenever wave status or completion evidence changes, which is its normal role.
Read the tracked files directly rather than reconstructing them from memory, and
verify a digest before treating a planning source as current.

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
| W8 | REL-002 restored the `scan:legacy-surface` release gate on the candidate HEAD; no product code, Skill surface, or release byte changed |
| W9 | UI-004, VAL-002, RND-002 closed three verified contract gaps; DOC-001 corrected DES-017; REL-003 re-cut the candidate and rebound every recorded digest |
| W10 | A second audit round over the I/O, consume, generator, telemetry, and Skill surfaces confirmed five more defects; IO-001, VAL-003, GEN-002, and TEL-002 closed them and REL-004 re-cut the candidate |
| W11 | UI-005 rebuilt the Approval HTML on the user's approved workbench prototype; REL-005 re-cut the candidate |
| W12 | CI-001 bounded the Playwright browser install after an apt-mirror degradation hung a CI job for 3h05m; no product byte changed |
| W13 | DOC-002 promoted the approved workbench visual system into the contract (spec §7.2, DES-019/§11.8) and rebound the planning-source digests; docs-only |
| W14 | CI-002 moved every browser lane into the digest-pinned official Playwright container image — apt and the browser download left the CI job graph entirely; approved via the round-1 review packet (9/9 PASS) |
| W15 | UI-006 landed the user's five usage-feedback fixes on the workbench (aria-pressed toggle, note-target labeling, termRef hover preview, in-contract readability, plain-language authoring rules); REL-006 re-cut the candidate |

W15 came from the user actually reviewing on the workbench and reporting five
issues, each adjudicated on the record (task.md §9). The action chips now honour
the aria-pressed toggle they always advertised — a second activation of a
recorded PASS revokes it, while the input-bearing actions reopen their prefilled
editor carrying an explicit revoke button so one keypress can never destroy
typed review text (spec §9.1 and §9.3 both satisfied). The rail note editor
names the block it writes to, termRef terms gained a hover/focus definition
preview that only supplements the click disclosure and glossary appendix
(spec §7.2 unchanged), tables gained in-contract header emphasis and zebra
striping, and the Skill's authoring references now mandate zero-context plain
language, termRef-bound terminology, and structured visualization. The palette
redesign portion of the feedback was not adopted: the visual system is the
user-approved DES-019 contract, and replacing it needs a newly approved
prototype, which was put back to the user as an open proposal. REL-006 re-cut
the candidate; the digests above are current.

W14 finished what W12 bounded. The user asked for the apt-degradation cure to
be researched and adjudicated through the Skill's own dual-audience review flow:
a nine-block review document (four T2 decisions) came back from the approval
workbench with every block PASS, and the approved option is the official
Playwright container image. The browser matrix and firefox-smoke now run inside
`mcr.microsoft.com/playwright:v1.62.1-noble` pinned by digest with
`--user 1001 --ipc=host`; browsers and system libraries come from the image, so
no browser download and no apt-get runs in any lane. `actions/setup-node` still
pins Node 24.19.0 inside the container (the runner mounts the hosted tool
cache), both lanes assert the exact version, and a mutation-verified unit test
(`tests/unit/playwright-container-lockstep.test.ts`) fails the build if the
image tag ever drifts from `@playwright/test` in package-lock.json. The W12
install script and browser cache steps were retired per the approved
disposition — git history is the rollback path — and `concurrency` now cancels
superseded runs on PR branches only. The approved fallback specification
(per-browser apt trimming, mirror demotion, version-keyed caching) is preserved
in the review document's B005 for the day the container path fails. No product
byte changed; the REL-005 candidate digests are untouched.

W13 and W12 are governance and infrastructure waves; neither touched a product
byte, so the REL-005 candidate and every artifact digest are unchanged. W12
(CI-001) answered a real incident: PR #68's first CI run hung for 3h05m inside
`playwright install-deps` after the Azure-internal apt mirror degraded, and the
user ordered the run paused and the CI fixed first. The install step is now two
phases — browser download stays fatal, apt system dependencies retry bounded
(240s x 3, lock cleanup between attempts) and degrade to a `::warning` — with the
browser directory cached across runs; it self-validated on PR #69 and on PR #68's
green re-run before either merged. W13 (DOC-002) closed the contract gap W11 left
behind: spec §1 still excluded all CSS values while the user had already approved
a concrete visual system as a requirement. The spec now carries that single
exception (§7.2 clause, §17.2 convergence row, §18.1 change record), design
carries the normative token list (DES-019, §11.8), and the digests above were
rebound in the DOC-001 order.

W11 exists because the visual layer was never part of the contract. `spec.md` §1
excludes page DOM and CSS values by design, so the implementation invented its own
look instead of the approval-workbench prototype the user had already approved and
been using. UI-005 adopts that prototype's visual system — warm paper palette,
tier-coloured left borders that switch to decision state, tier pills, keycap action
chips, the real progress fill bar, filter pills, and the compact rail — while
keeping the accessibility contract (landmarks, skip link, `aria-live` status,
`aria-pressed`, focus outlines, `j`/`k`/`n`/`1`-`4`). Layout follows the prototype's
reading order: the decision blocks lead, and the continuation and evidence panels
stay in the same file but folded into closed disclosures, which keeps spec §7.2
self-sufficiency without pushing the first decision below the fold. Three prototype
rules were adapted rather than copied because they measured as WCAG failures: the
frozen-card `opacity:.75` (6 serious contrast violations) became a recess, and two
decorative tokens gained text-safe variants. The 350 KiB shell budget moved to
384 KiB; the approved design is the requirement and the budget was a guardrail.

W10 came from a second adversarial round aimed at the modules the first sweep had
only reached indirectly. Its most serious finding is a data-loss path: a `replace`
whose new bytes equal the installed bytes produced a manifest with equal old and
new digests, and every recovery-cursor predicate is digest-only, so the states
aliased. Re-running `render --replace-generated` on an unchanged document — an
ordinary retry, since generation is deterministic — exited 70 and left the output
root permanently unwritable, and a crash in the staging window deleted the user's
delivered file instead of restoring it. IO-001 excludes such a target from the
transaction entirely, so the ambiguous manifest can no longer be created. VAL-003
gave `render` the legacy-contract gate that every other document reader already
had, and aligned the `/derived/N` pointer index space between the CLI and the
protocol, which sorts by topicId. GEN-002 restored the blank line that keeps a
step's leading code block an indented code block rather than lazy paragraph
continuation of untrusted text. TEL-002 stopped the content-free metric
summary from silently truncating an eligible cohort to the sample window, which
could report `通过` for a cohort that is actually `未达标` — precisely what spec
§6.3 forbids. Its authorization gate is unchanged and still governs section 6.6.

W9 closed four gaps that an adversarial re-audit of the frozen candidate
confirmed against `spec.md`: a workbench note edit was keyed to the moving review
cursor so an ordinary block click silently discarded it, and every rejected action
announced a raw reducer enum into the aria-live region (§9.3, §13.5); the privacy
scan missed a personal absolute path unless the user-name segment was followed by
a separator *and* preceded by whitespace, a quote, or a bracket, so a bare home
directory and the CJK-adjacent form normal in this Chinese-first product both
passed (§13.2); an author-left `@@DAR_*@@` or `{{UPPER}}` placeholder in document
prose was invisible to `validate delivery` because Markdown escaping encodes those
characters and the Approval HTML carries the document as base64 (§14.1, §7.4); and
`permittedChanges` admitted the candidate's own `lineage.impactAssessments`, so one
reviewer `EDIT` authorized rewriting any pending block — with the impact closure
unioning the current and candidate dependency graphs, a candidate could even
manufacture the edge it then cited (§11.3). Each fix carries a mutation-verified
regression test. Tightening the transition broke no existing round, consume, or
acceptance test, which is itself the finding: that gap had no coverage at all.

W8 is a post-freeze maintenance wave, not progress on W7. The 2026-08-17 documentation
consolidation was pushed straight to `codex/v0.2.0`, where CI runs on neither
`pull_request` nor `push: main`, so nothing validated it: the newly tracked
`docs/{spec,design,task}.md` describe the retired v0.1 contract, its retired
static human-narrative artifact suffix, and the retired Python filenames, which
`scan:legacy-surface` read as current public promises and rejected with rc=3. REL-002 gave the scanner an
explicit three-path planning-record boundary (never a `docs/` prefix), added
`tests/unit/legacy-surface.test.ts` so `npm run test:unit` reproduces that class of
regression, and put the candidate integration branch on the CI push trigger. The
candidate ZIP and manifest digests in section 1 are unchanged and still verify.

### Historical task sequence and remaining dependency

The implementation sequence was deliberately ordered as W0 governance and
schema baseline, W1–W3 protocol/CLI/Skill/workbench construction, W4–W5
consume/assembly/integration proof, and W6 release packaging. Those completed
waves are implementation evidence, not permission to invent a pilot.

**PIL-001 completed on 2026-08-20**: a genuine user-authorized case ran the full
generate→approve→packet→consume→finalization loop through the verified ZIP
runtime, every validation passed, and the user confirmed the case genuine and
useful, then separately authorized closing #61 with the content-free template.
Public record is exactly: `PIL-001: status=completed; validation=pass; content
remains private.` The content-free burden metrics were NOT captured — the usage
state directory stayed unauthorized, so no record-usage call was made and no
CLI-backed metric is claimed; that blocker is logged in the private closure
note. The only remaining step is **MET-001**, and only after three to five
independently eligible real cases exist. A fixture, a replay no-op, a synthetic
reader test, or a green CI run cannot substitute. Keep #62 deferred until the
sample threshold and measurement contract are actually met.

Representative final candidate evidence was unit `502/502`, release E2E `7/7`,
browser `88` pass plus `2` designed skips, and coverage statements/branches/
functions/lines of `91.53%`/`85.47%`/`97.30%`/`94.75%`. Generated-artifact,
installed-skill, legacy-interface, privacy, distribution, and pinned Skill
validation gates passed. Refresh live state before calling these current.

| Remaining task | GitHub issue | State | Completion proof |
|---|---|---|---|
| PIL-001: one genuine business approval loop | [#61](https://github.com/xiuyu0000/agent-reporting-skills/issues/61) | completed 2026-08-20; #61 closed with the content-free template | Full loop ran and validated on the verified ZIP runtime; user confirmed the case genuine and useful; burden metrics not captured (usage-store authorization withheld — logged privately) |
| MET-001: 3–5 real-case metrics | [#62](https://github.com/xiuyu0000/agent-reporting-skills/issues/62) | deferred | Three to five eligible cases meet the measurement contract, or report `尚未验证` honestly |

W0–W6 milestones are closed. W7 stays open while #62 is open (#61 closed
2026-08-20). Green fixtures cannot close it.

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
  'c607212389ff233c0ec69fadc722b235190ac94d11d45cfdb63c92556c1a4b9b' 'dist/deliver-dual-audience-report-v0.2.0.zip' \
  '50fecddd6a0f699d3c42fa9793eb567920f1b7c600f179d76a36121ed517cbb3' 'dist/deliver-dual-audience-report-v0.2.0.manifest.json' \
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
npm run scan:legacy-surface
npm run verify:dist
git diff --check
```

`validate:skill` needs the external validator pinned by
`.github/workflows/validate.yml`; without it the command exits 3 with
`unable to execute pinned Skill validator`, which is a missing local tool, not a
Skill defect. `scan:legacy-surface` is listed because a documentation-only commit
already broke it once — run it on the branch you actually intend to merge.

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
