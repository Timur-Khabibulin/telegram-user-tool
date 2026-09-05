---
name: feedback_dont_override_requirements_from_code_inference
description: Don't override an explicit, literal case in a confirmed requirements doc based on inferred rationale from existing v1 code behavior — check the analyst's memory file first
type: feedback
---

When a requirements document explicitly and literally describes a case (e.g. "message
X is also a valid input, handle it via rule Y"), do not decide to skip/reinterpret it
because existing code already does something that happens to look similar (e.g. "v1
already filters this out, so v2 can keep doing that"). The existing code's behavior
may predate the feature and exist for unrelated reasons — "current code already does
X" is not evidence the new spec wants X.

**Why:** on post-freshness-gate (2026-07-06), I decided not to implement "case B" of
the algorithm (a message that is itself the channel's auto-forwarded post copy)
because v1's `TelegramService.getMessages` already filters such messages out as
noise. The requirements doc had already explicitly specified this case (confirmed by
the coordinator, and documented in the business-analyst's memory file
`project_monitor_post_freshness.md`, which I had not checked). The coordinator
corrected this as a real error, not a judgment call I was free to make — see
[[project_post_freshness_gate]] for the full correction.

**How to apply:** before deciding that a requirements-literal case can be dropped as
"just an optimization" or "not worth the complexity," (1) re-read the requirements
doc fully rather than skimming for the part relevant to the code you're looking at,
and (2) check whether a business-analyst memory file exists for the feature
(`.claude/agent-memory/bussines-system-analytic/`) — it often has the negotiation
history and explicit coordinator confirmations that the requirements doc itself
compresses into a terse business rule. If a case is spelled out step-by-step in an
approved algorithm, implement it; raise deviations as an explicit open question
instead of silently resolving them in the architecture doc.
