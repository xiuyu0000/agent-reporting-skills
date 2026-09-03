# Agent operating contract

This repository contains the v0.2 `deliver-dual-audience-report` candidate.
These rules apply to Claude Code, Codex, and any other automation working in
this repository.

## Read before acting

1. Read [the Claude Code handoff](docs/claude-code-handoff.md).
2. Read [the Claude Code entry point](CLAUDE.md) when Claude Code is the
   active tool.
3. Read [the Skill workflow](skills/deliver-dual-audience-report/SKILL.md)
   before using the Skill.
4. Read the relevant files in
   [the Skill references](skills/deliver-dual-audience-report/references/)
   before collecting evidence, creating a contract, importing a packet, or
   consuming a round.
5. Read [the docs index](docs/README.md), then the tracked planning sources
   [spec](docs/spec.md), [design](docs/design.md), and [task](docs/task.md),
   before changing scope, acceptance criteria, or wave status.

`AGENTS.md` in a parent directory belongs to another project and is not an
instruction source for this repository.

## Authority and working-tree rules

- Treat `codex/v0.2.1` (integration branch since 2026-09-03) and its recorded
  candidate baseline as the release lineage and the base for every PR. `main`
  is kept tree-identical to it by the established `-s ours` sync merge; still
  branch from `codex/v0.2.1`. `codex/v0.2.0` is frozen at `3ff6509` as the
  v0.2.0 candidate lineage and is not a PR base. Run pilot work only in the
  dedicated worktree the handoff prescribes.
- Use an isolated feature worktree and branch for repository changes. Inspect
  `git status`, branch, parent SHA, and `git worktree list --porcelain` before
  mutating files.
- Preserve unrelated dirty files, worktrees, branches, historical release
  artifacts, and ignored local material. Never reset, clean, or delete them
  without explicit user approval.
- The planning sources `docs/spec.md`, `docs/design.md`, `docs/task.md`, and
  `docs/README.md` are tracked as of 2026-08-17 so that every worktree and
  branch reads the same version. Keep them synchronized with
  `docs/claude-code-handoff.md`, refresh the bound SHA-256 values after any
  change, and treat them as public-tree text: no business body, proposal title,
  document ID, approver identity, personal absolute path, or credential.
- `docs/调研/` stays local, private, and `.gitignore`-excluded. Never commit it
  or copy its body into a tracked file; tracked documents keep only provenance
  references to it.
- Recheck live GitHub/CI/release state before describing it as current. A
  historical handoff value is evidence, not a substitute for a live check.

## Pilot and privacy hard stops

- PIL-001 starts only after the user authorizes the named execution platform
  and private channel to process real business material, then supplies the
  minimum needed metadata through that authorized private channel or a
  user-operated local file picker: one exact local proposal path plus explicit
  read permission, one real approval objective and primary approver, and
  explicit permission to write under a named private output root. Running the
  verified release ZIP also needs a separately named private
  extraction/runtime root. If the platform could upload material, the
  authorization must explicitly cover that disclosure.
- The initial proposal must contain at least four naturally independent
  decisions. Never split or pad content merely to cross the threshold.
- Keep proposal text, titles, paths, document identifiers, packets, receipts,
  screenshots, captures, approver/reviewer/participant identities,
  credentials, and session metadata out of the public repository, public
  issues, commits, PRs, and chat summaries. Never ask for or echo a pilot body
  in chat. A user may provide only the minimum path metadata through the
  already-authorized private channel or file picker; never echo that path or a
  title in a public, unapproved, or retained chat or terminal output. Read the
  body and title only from the user-authorized private file.
- A final handoff containing document identity and artifact links is allowed
  only in a current user-authorized private channel. A public status must omit
  document IDs, paths, links, artifact names, safe summaries, and business
  details, and it also needs separate current authorization before publication.
- Before sending Agent Markdown or Approval HTML to any additional person,
  model, platform, or cloud service, obtain current private-disclosure
  authorization for that named recipient and channel. Without it, do not send
  the material and keep reader-isolation validation incomplete.
- Creating Approval HTML under a private root does not authorize delivery to
  the primary approver. The user must either distribute it personally or
  separately authorize the named approver's private channel; do not send it
  automatically.
- A CLI success does not authorize external execution, publication, a tag,
  a GitHub Release, or a write outside the current user-authorized boundary.
- For each tracked or potentially public `init`, `render`, or `consume` write,
  obtain a fresh explicit confirmation and use the matching CLI confirmation
  flag. Do not treat a previous confirmation as continuing authority.

## Verification and handoff

- Use the public `review-delivery.mjs` CLI only; do not hand-edit generated
  Agent Markdown or Approval HTML.
- Validate before and after any real packet consumption. Preserve a
  content-free local evidence record only after successful validation.
- Every `record-usage` invocation, including `append` and `summarize`, touches
  `~/.codex/state/deliver-dual-audience-report/usage`, not the delivery output
  root. Obtain separate current authorization for that state directory before
  invoking either operation; otherwise do not record or claim CLI-backed
  metrics. Treat only a JSON result with `status: "recorded"` as recorded; its
  exit code alone is not evidence.
- Keep uncertainty classes distinct and deliver only the current validated
  handoff's two canonical artifacts. Do not guess paths, identities, or
  summaries.
- Before committing documentation or code, run the proportionate checks, link
  checks, privacy scan, and `git diff --check`; then use an exact-SHA review
  flow before merging.

The detailed release evidence, command sequence, and PIL/MET acceptance
criteria are in [docs/claude-code-handoff.md](docs/claude-code-handoff.md).
