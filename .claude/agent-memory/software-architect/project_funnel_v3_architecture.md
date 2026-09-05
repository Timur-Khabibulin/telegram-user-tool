---
name: project-funnel-v3-architecture
description: Архитектурные решения funnel-tracking v3 (US-1..US-5) поверх v2 — где хранится агент→ссылка, фильтр по link, судьба dmsSent/groupReplies, chatUsername для US-5
metadata:
  type: project
---

Полный документ: `docs/design/funnel-tracking/architecture-v3.md` (аналог
`architecture-v2.md`, US-1..US-5 из `requirements-v3.md`).

**Ключевые находки, не очевидные из самого ТЗ:**

- **`private-invite-links` (агент → инвайт-ссылка в приватный канал) уже
  реализован кодом** (`core/db/private-invites.ts`, таблица
  `private_invite_links` в `private-invites.db`, workspace
  `FUNNEL_ADMIN_AGENT_ID`, инструмент `tg_private_invite_links`) — все задачи
  в `openspec/changes/private-invite-links/tasks.md` отмечены выполненными,
  хотя change ещё не заархивирован (`openspec/specs/funnel-metrics/spec.md`
  всё ещё описывает старое поведение через agent1). `requirements-v3.md`
  описывает создание ссылок как «ещё не выполненную задачу» — это
  расхождение с фактическим состоянием кода стоит проверить у координатора
  (создан ли механизм — да; сгенерированы ли реальные ссылки для всех
  активных агентов — отдельный, уже не архитектурный вопрос).
- **`channels.channelId/channelUsername/channelResolved`** — это НЕ
  собственный username чата, а идентичность **привязанного broadcast-канала**
  (channel-content-analysis, `resolveLinkedBroadcast`). Для обычной группы
  без привязанного канала эти поля пусты навсегда. Для US-5 (ссылка на сам
  чат, куда агент пишет) пришлось вводить отдельную новую колонку
  `chatUsername`, заполняемую из уже получаемых, но отбрасываемых данных
  `listGroupChannels()` (`d.entity.username`) — без новых MTProto-вызовов.
  Название `chatUsername` намеренно не `channelUsername` — риск путаницы
  с существующей колонкой другого смысла в той же таблице.
- **`daily_stats.group_replies` — внешний контракт с `.claude/skills/funnel-stats/`**
  (отдельный, независимый Excel-скилл, читает `funnel.db` напрямую по SQL на
  VPS, считает конверсию `views_delta / SUM(group_replies)`). US-2 меняет
  отображаемый показатель «сообщений отправлено» на «каналов с отправкой», но
  **нельзя** просто переименовать/переиспользовать поле `groupReplies` под
  новый смысл — это бы задним числом сломало формулу конверсии skill'а за всю
  историю. Решение: `groupReplies` (сырой счёт сообщений) остаётся,
  продолжает писаться в БД, просто не отображается в отчёте; новое поле
  `channelsWithSending` — параллельно, только для дисплея, не персистится.
  `daily_stats.dms_sent`, наоборот, не имеет внешних читателей — решено
  оставить колонку, всегда писать 0, без миграции/DROP COLUMN.
- **Официальный формат `t.me/c/<channel>/<id>` требует id сообщения**
  (проверено через `core.telegram.org/api/links`, не по памяти) — бессмысленно
  строить ссылку «просто на канал» без якоря-сообщения для приватных
  супергрупп/каналов; для базовых («не апгрейженных») групп у Telegram нет
  постоянной ссылки вообще ни в каком формате — решено как факт платформы, не
  как пробел в модели данных.

**How to apply:** перед тем как переиспользовать/переименовывать любое поле
`AgentFunnelRow`/`daily_stats`, проверить `.claude/skills/funnel-stats/SKILL.md`
и `build_funnel_xlsx.py` — это скрытый читатель `funnel.db`, не видный из
`src/`. Связано: [[project-funnel-v2-storage]] (хранение этапов 1-4),
[[feedback-check-hidden-schema-consumers-before-renaming]].
