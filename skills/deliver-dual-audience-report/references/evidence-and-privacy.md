# Evidence, freshness, and privacy

## Source hierarchy

Record sources from strongest to weakest before drafting. Prefer live system
state and canonical source files over summaries. A report, memory entry, or
previous chat may help locate evidence but is not automatically authoritative.

If two sources conflict, preserve both claims, identify the stronger source,
and explain the decision. Do not hide the conflict.

## Freshness

Every report has one ISO-8601 `as_of` value. Refresh volatile claims—live issue
state, CI, prices, schedules, permissions, or current ownership—immediately
before final validation. Static design decisions do not need artificial
refreshes.

## Privacy

Publish only the minimum evidence needed to support the conclusion. Exclude:

- raw chat transcripts and verbatim private prompts;
- full command output, source code dumps, or private project material;
- credentials, tokens, cookies, authorization headers, or URL credentials;
- personal absolute paths, Session IDs, and user-identifying metadata; and
- external runtime resources in the human HTML.

Use neutral labels such as `$HOME` or `$PROJECT_ROOT` only in an Agent document
when a path concept is necessary. Human reports should usually describe the
location rather than expose a machine path.

## What scripts can and cannot prove

The validator can prove file presence, metadata alignment, shared marker
digests, link integrity, basic HTML structure, and common leak patterns. It
cannot prove that a conclusion is true, that prose is understandable, or that
two unstructured paragraphs do not contradict each other. Those remain explicit
semantic review steps in the Skill.
