# Agent Reporting Skills

Open Agent Skills for turning one verified evidence set into reports that work
for different readers.

## Included Skill

### `deliver-dual-audience-report`

Use this Skill when a task explicitly requires both:

- an Agent-facing Markdown document for precise continuation; and
- a human-facing, self-contained HTML document for zero-context understanding.

The Skill keeps semantic writing flexible. Two Python standard-library scripts
make the delivery contract deterministic: they create both files early and
check that both are complete, aligned, private, linkable, and ready to hand off.

Do not use it for a single report, a chat-only answer, or a code-only task.

## Install

Clone this repository, then link or copy the Skill directory.

```bash
# Codex / open Agent Skills location
ln -s "$PWD/skills/deliver-dual-audience-report" \
  "$HOME/.agents/skills/deliver-dual-audience-report"

# Claude Code personal Skill location
ln -s "$PWD/skills/deliver-dual-audience-report" \
  "$HOME/.claude/skills/deliver-dual-audience-report"
```

Codex installations that use `~/.codex/skills` may link the same directory
there. Claude Cowork users can upload the ZIP attached to each release.

Invoke it explicitly with `$deliver-dual-audience-report` when you need the
two-artifact contract.

## Quick start

```bash
python3 skills/deliver-dual-audience-report/scripts/init_delivery.py \
  --output-dir ./report \
  --base-name project-review \
  --title "Project Review" \
  --language en \
  --as-of 2026-07-21T16:00:00+08:00

# Complete report-contract.json and both documents, then validate.
python3 skills/deliver-dual-audience-report/scripts/validate_delivery.py \
  --contract ./report/report-contract.json
```

The validator writes `delivery-receipt.json` and `delivery-receipt.md` only
after all checks pass.

## Privacy

This repository contains only generic workflow guidance and synthetic tests.
It contains no chat transcripts, real project reports, Session identifiers,
credentials, or personal absolute paths.

## Compatibility

The Skill follows the open [Agent Skills specification](https://agentskills.io/specification).
Its Markdown workflow is portable across Codex, Claude Code, and Claude Cowork;
`agents/openai.yaml` adds optional Codex UI metadata.

## Development

```bash
python3 -m unittest discover -s tests -v
python3 skills/deliver-dual-audience-report/scripts/validate_delivery.py --help
```

## License

Apache-2.0. See [LICENSE](LICENSE).
