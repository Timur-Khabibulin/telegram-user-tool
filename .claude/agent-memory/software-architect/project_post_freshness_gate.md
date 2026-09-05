---
name: project_post_freshness_gate
description: Architecture for post-freshness-gate (monitor-v2) — additive second monitor variant, per-agent toggle via existing tasks table, shared-state hazard in channels.lastProcessedAt; corrected after wrongly skipping algorithm case B
type: project
---

Post-freshness-gate feature (docs/design/post-freshness-gate/architecture.md,
2026-07-06): adds `monitor-v2` as a fully separate skill/TaskType alongside the
existing `monitor` (v1), which must not be modified. Key reusable pattern for this
codebase: **per-agent variant toggle needs no new entity** — the existing `tasks`
table (`core/db/tasks.ts`, PK `(agentId, type)`) already supports enabling an
arbitrary subset of `TaskType` per agent, so "choose old vs new skill per agent" is
just "enable one of two TaskType rows, not both." Applies to any future "v2 skill
that coexists with v1" request in this repo.

**Why:** user explicitly required additive-only (old skill untouched, both available,
selectable per agent) — this is a recurring instruction style for this project
(prefers coexistence over risky rewrites for behavior-changing features).

**Shared-state hazard found:** `channels.lastProcessedAt` (single column, no variant
awareness) is written by `markChannelProcessed` regardless of which monitor variant
ran. If two monitor variants with different check periods (e.g. 72h vs 24h) were
both enabled for the same agent, they'd stomp each other's cadence. Coordinator
explicitly decided NOT to guard this in code (scheduler-control.ts) — left as
operator responsibility. Don't re-propose a code guard for this specific case unless
asked again.

**How to apply:** when designing another "v2" of an existing per-channel/per-chat
skill in this repo, check whether the skill's DB state (e.g. `lastProcessedAt`-style
columns) is variant-aware — it usually isn't, since state is normally keyed by
`chatId`/`agentId` only. Flag this explicitly rather than assuming coexistence is
free.

**Correction after coordinator feedback (2026-07-06):** first draft of this
architecture wrongly decided NOT to implement "case B" of the algorithm (a message
that is itself the channel's auto-forwarded post copy, `fwd_from.channel_post`) —
reasoning was "v1's existing filter (`if (m.sender instanceof Api.Channel) skip`)
already excludes these as noise, so v2 can keep doing that." This was wrong: the
requirements doc explicitly specifies this as a first-class case (case B, algorithm
step 2), separately confirmed by the coordinator/analyst
(`.claude/agent-memory/bussines-system-analytic/project_monitor_post_freshness.md`).
**Lesson: when a requirements doc explicitly and literally describes a case, don't
override it based on an inferred rationale from existing v1 code — the existing
code's filter existed for reasons unrelated to the new feature, and "v1 already does
X" is not evidence that v2 should too.** Check the analyst's memory file for the
feature before concluding a requirements-literal case is "just an optimization to
skip." Correct design: `monitor-v2` must NOT reuse v1's channel-sender filter — new
`getMessages(..., { includeChannelPosts: true })` opt-in param, message flows into
`classifyMessages`'s `generalMessages` bucket naturally (no `replyToMsgId`), gated by
the same R1/R2/R3 as everything else, with its own `date` field as the post date
(no cache, no Telegram call for this case).

Also: R1 was reformulated by the coordinator from "post published today" (calendar
day) to "less than 24h since publication" (sliding window, symmetric with R2) —
**this removed the need for any timezone convention in this feature.** The earlier
draft had reused `startOfUtcPlus5Day` (`core/runs-summary.ts`, the project's one
existing "day boundary" convention, used by daily-summary/funnel-tracker/dm-replies)
for R1 — no longer applicable here, but still the right reference for any *other*
future "is it today" logic in this repo — see [[project_funnel_v2_storage]] for
another example of the "reuse existing per-agent DB module, add a table, don't spin
up a new DB file" pattern.
