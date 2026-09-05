---
name: feedback-check-hidden-schema-consumers-before-renaming
description: Before repurposing/renaming a persisted DB field, search the whole repo (including .claude/skills/) for readers outside the module that writes it
type: feedback
---

Before changing what a persisted column means (not just its display label), grep
the *entire* repo — including `.claude/skills/*/`, deploy scripts, and anything
that talks to a DB file directly via `sqlite3`/SSH — for other readers. A column
can have a consumer that never appears in `src/` at all.

**Why:** while designing funnel-tracking v3 (US-2, replacing "messages sent" with
"channels with sending"), the obvious move was to repurpose `AgentFunnelRow.groupReplies`
/ `daily_stats.group_replies` to mean the new channel-count metric. Grepping found
`.claude/skills/funnel-stats/SKILL.md` and `build_funnel_xlsx.py` — a separate,
independent Excel-report skill that SSHes to the VPS and runs raw SQL against
`funnel.db`, computing a "views per reply" conversion rate directly from
`SUM(group_replies)`. It has no import/reference from anywhere in `src/` — the only
way to find it was searching the whole tree, not just the code that writes the field.
Renaming the field's meaning in place would have silently corrupted that skill's
historical conversion-rate analytics with no error, no test failure, nothing.

**How to apply:** treat any table written by app code but living in a per-agent or
admin workspace DB (`funnel.db`, `tasks.db`, etc.) as having potential *out-of-repo-code*
consumers (ops skills, SSH one-liners, dashboards). Before reusing a column for a new
meaning, grep broadly (not just `src/`) for the column name. If a hidden consumer
depends on the old semantics, keep the old field writing unchanged and add a new,
separate field for the new display concept rather than repurposing — see
[[project-funnel-v3-architecture]] for the concrete resolution (kept `groupReplies`
persisted as-is, added `channelsWithSending` for display only).
