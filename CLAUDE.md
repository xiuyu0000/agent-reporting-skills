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

The v0.2 candidate is on `codex/v0.2.0`; do not use the older root `main`
worktree for this workflow. The handoff records the exact baseline, release
evidence, remaining PIL-001/MET-001 work, required user authorization, and
the mandatory stop conditions.

These repository entry points travel with a repository clone/worktree, not
with the release ZIP. The ZIP intentionally contains only the installed Skill
runtime. Read this repository handoff first, then run a real pilot only through
the separately verified and privately extracted ZIP runtime described there.

Do not inherit an `AGENTS.md` from a parent directory. It belongs to an
unrelated project and conflicts with this repository's Skill workflow.
