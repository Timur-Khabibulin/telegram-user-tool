---
name: feedback_no_document_edit_history_narrative
description: Architecture/requirements docs must state final decisions only, not narrate how the document itself changed across revisions
type: feedback
---

Don't write meta-narrative about a document's own revision history into the document
body — no "первая версия документа ошибочно решила...", "после правки координатора",
"ранее закрытые в этой ревизии пункты...", "предыдущая версия документа...". A
design/requirements doc should read as if written once, in its final correct form.

**Why:** on post-freshness-gate (2026-07-06), after correcting a wrong architectural
decision (see [[project_post_freshness_gate]]), I left a "> **Ревизия.**" blockquote
explaining what the first draft got wrong and why, plus similar narrative sentences
scattered through the doc ("ключевое отличие от предыдущей версии документа...",
"ранее закрытые в этой ревизии пункты..."). Coordinator explicitly rejected this:
the document is not a changelog of itself.

**How to apply:** when correcting a design doc after feedback, edit the affected
sections to state the *corrected* decision directly, as if it had always been that
way. Do not add framing sentences that reference the document's own prior state,
drafts, or the fact that a correction happened. This applies to `architecture.md`,
requirements docs, ADRs — any artifact whose job is to describe current-state
decisions, not the process of arriving at them (contrast with git history / this
agent's own memory, which *are* the right place to record that a mistake happened
and why).

**What is NOT covered by this rule:** comparing architectural alternatives ("Вариант
A выбран / Вариант B отклонён") is normal document content — that's about the
decision, not about the document's edit history. Only remove narrative about *how the
document changed*, not comparisons between *design options*.
