# Claude Code entry point

Use this file as the Claude Code entry point for this repository. It is a
portable Markdown pointer, not a filesystem symlink.

Before planning, editing, validating, or handling a real pilot, read in this
order:

1. [AGENTS.md](AGENTS.md)
2. [Claude Code handoff](docs/claude-code-handoff.md)
3. [Skill workflow](skills/deliver-dual-audience-report/SKILL.md)
4. The stage-appropriate reference in
   [`skills/deliver-dual-audience-report/references/`](skills/deliver-dual-audience-report/references/)

For requirement, design, or task detail, read [the docs index](docs/README.md)
and the tracked planning sources it lists: [spec](docs/spec.md),
[design](docs/design.md), and [task](docs/task.md). They are tracked as of
2026-08-17, so the same version is available in every worktree and branch;
`docs/调研/` remains local, private, and `.gitignore`-excluded.

`codex/v0.2.0` is the integration branch for this workflow: base PRs on it and
read candidate state from it. Since 2026-08-20, `main` is kept tree-identical
to `codex/v0.2.0` by an `-s ours` sync merge after each integration change, so
either checkout carries the same content; pilot flows still require the
dedicated clean worktree and the extracted ZIP runtime the handoff prescribes.
The handoff records the exact baseline, release evidence, remaining MET-001
work, required user authorization, and the mandatory stop conditions.

These repository entry points travel with a repository clone/worktree, not
with the release ZIP. The ZIP intentionally contains only the installed Skill
runtime. Read this repository handoff first, then run a real pilot only through
the separately verified and privately extracted ZIP runtime described there.

Do not inherit an `AGENTS.md` from a parent directory. It belongs to an
unrelated project and conflicts with this repository's Skill workflow.
