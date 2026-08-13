# Agent Reporting Skills

Open Agent Skills for turning one verified evidence set into precise continuation
context and an offline approval workspace.

## Included Skill

### `deliver-dual-audience-report`

Use this Skill for a single approver with a clear approval goal when the initial
plan naturally contains at least four independently decidable items and the
task needs both default artifacts:

- Agent Markdown for exact continuation without hidden chat context; and
- self-contained Approval HTML for reading, deciding, recovery, and exporting
  a structured `review-packet/1` receipt.

The canonical input is `review-document/1`. The Approval HTML works offline and
the Agent Markdown and Approval HTML are generated together from the same
validated snapshot. Do not use this Skill for multi-reviewer work, fewer than
four natural decisions, free-form reading, a single report, a chat-only answer,
or a code-only task without a separate approval deliverable.

## Requirements and install

- Node.js 24.x (`>=24 <25`) is required to run the installed CLI.
- The v0.2 ZIP contains the complete 11-file Skill and needs no `npm install` or
  `node_modules` at runtime.
- Development from this repository uses the committed npm lockfile and
  `npm ci`.

Install the release candidate ZIP:

```bash
unzip dist/deliver-dual-audience-report-v0.2.0.zip -d /path/to/skills
node /path/to/skills/deliver-dual-audience-report/scripts/review-delivery.mjs --help
```

Or clone this repository and link the complete Skill directory:

```bash
ln -s "$PWD/skills/deliver-dual-audience-report" \
  "$HOME/.agents/skills/deliver-dual-audience-report"
```

Codex installations that use `~/.codex/skills` may link the same directory.
Claude Code may use `~/.claude/skills`. Invoke the Skill explicitly with
`$deliver-dual-audience-report` when the trigger contract applies.

## v0.2 CLI workflow

The only installed entry point is:

```bash
node /path/to/deliver-dual-audience-report/scripts/review-delivery.mjs <command>
```

It exposes five commands:

- `init` creates a safe draft `review-document/1` contract.
- `render` validates an `in-review` document and atomically generates Agent
  Markdown plus Approval HTML.
- `validate` checks delivery, batch, packet, state, or transition inputs without
  modifying them.
- `consume` validates a receipt and Agent-authored next-round candidates before
  atomically publishing their contracts and paired artifacts.
- `record-usage` appends or summarizes content-free local workflow metrics.

For example:

```bash
CLI=/path/to/deliver-dual-audience-report/scripts/review-delivery.mjs

node "$CLI" init \
  --output-dir ./review \
  --base-name project-review \
  --title "Project Review" \
  --language en \
  --ui-locale en \
  --as-of 2026-08-13T09:00:00Z

# Replace every draft slot, add verified evidence, and set status to in-review.
node "$CLI" render --document ./review/review-document.json
node "$CLI" validate delivery --document ./review/review-document.json
```

Before passing `--confirm-output-scope tracked` or `public`, obtain explicit
current approval for that destination and, for public output, explain the
disclosure risk. CLI success does not authorize external execution.

Protocol details and exact options live in
[`review-protocols.md`](skills/deliver-dual-audience-report/references/review-protocols.md).

## Release candidate verification

The checked-in v0.2 candidate is accompanied by an external manifest containing
the archive digest, byte length, Node range, exact sorted inventory, and each
file digest. Rebuild and verify it with Node 24:

```bash
npm ci
npm run build
npm run release:build -- --version 0.2.0
npm run verify:dist
npm run scan:legacy-surface
```

The build uses a stable bytewise path order, stored entries, the ZIP epoch
timestamp, mode `0644`, and no archive comments or extra fields. Verification
rebuilds from distinct physical roots, parses and checks every ZIP field,
extracts to a private temporary directory, and runs the installed CLI from an
unrelated working directory without npm state.

## Breaking migration and v0.1.0 rollback

v0.2 is intentionally incompatible with `dual-audience-report-contract-v1` and
does not silently convert that contract. The old static `*_HUMAN.html` output is
not an Approval workspace, and the v0.2 CLI rejects the old contract before
producing a seemingly valid delivery. Recreate the plan from its original facts
as `review-document/1`; historical packet/state prototype migration is available
only through the documented explicit identity-confirmation path.

For an unchanged old workflow, install the GitHub
[`v0.1.0` release](https://github.com/xiuyu0000/agent-reporting-skills/releases/tag/v0.1.0)
asset `deliver-dual-audience-report-v0.1.0.zip`. Its expected SHA-256 is
`3f7f22465c26b8eb88776ce5dcd5c7863c0763cb855464a463b0b7f5fa4f855b`.
Rollback does not convert v0.2 review documents into the old format; regenerate
from the original evidence. Other repository archives are historical evidence,
not the documented rollback baseline.

## Privacy

This repository contains generic workflow guidance and synthetic tests. CI scans
tracked public text for credential patterns, personal paths, session identifiers,
and retired active interfaces. The release verifier rejects unexpected or
development-only inventory and requires every v0.2 archive entry to be
byte-identical to its scanned Skill source. Do not place real proposals, private
approval receipts, or user captures in this repository.

## Compatibility

The Skill follows the open [Agent Skills specification](https://agentskills.io/specification).
Its Markdown workflow is portable across compatible hosts;
`agents/openai.yaml` adds optional Codex UI metadata. The CLI runtime contract is
Node 24.x.

## Development

```bash
npm ci
npm run build
npm run check:generated
npm run typecheck
npm run lint
npm run test:unit
npm run test:e2e
npm run test:browser
npm run test:coverage
npm run validate:skill
```

## License

Apache-2.0. See [LICENSE](LICENSE).
