---
name: project-channel-distribution-architecture
description: Находки при проектировании channel-distribution (Telegram-бот раздачи каналов) — мёртвые метрики-колонки, bot-прецедент, конфликт балансировок в спеке, статус channel-rotation
metadata:
  type: project
---

Архитектура фичи «распределение каналов по агентам через Telegram-бот»:
`docs/design/channel-distribution/architecture.md` (парный к `requirements-v1.md`,
R1..R28). Спроектирована, не реализована.

**Ключевые находки, проверенные grep/чтением (не выводятся дёшево заново):**

- **Фикс-колонки метрик в `discovered_channels` МЁРТВЫЕ.** `sub_count`,
  `avg_views`, `p50_user`, `p90_users`, `comments_per_day` и функция
  `setChannelMetrics` (`core/db/discovery.ts:152`) не имеют НИ ОДНОГО вызывающего
  и читателя во всём `src/`. Смена модели метрик на `metrics_json` безопасна по
  потребителям (но перед физическим DROP всё равно grep по `.claude/skills/` и
  `*.py` — прецедент скрытого читателя `funnel.db` у skill funnel-stats,
  см. [[project-funnel-v3-architecture]]).

- **Единственная Bot API-интеграция платформы — голый `fetch`, без фреймворка:**
  `core/review-bot-api.ts` (sendMessage/editMessageText/answerCallbackQuery/
  getUpdates long-poll/inline-кнопки/default-deny) + persistent-сервис
  `src/scripts/periodic/review-listener.ts` (`Type=simple`, `Restart=always`,
  `tg-review-listener.service`). Это прецедент для решения по боту — grammy/telegraf
  в проекте НЕТ (в deps только `telegram`=GramJS и `@mtcute/*`). Секреты бота
  (`TELEGRAM_REVIEW_BOT_TOKEN/CHAT_ID`) читаются из `~/.openclaw/secrets.env` через
  process.env в `config.ts`.

- **Топологический лимит: один `getUpdates`-long-poll на bot-токен.** review-listener
  уже занимает один. Вторая бот-фича обязана либо взять ОТДЕЛЬНЫЙ токен, либо слиться
  в тот же процесс. Отсюда рекомендация в доке: отдельный бот + отдельный
  distribution-listener, а тяжёлая работа — в oneshot-worker (`systemctl start` по
  образцу task-scheduler §3.6).

- **`channel-rotation` УЖЕ заархивирован** (`openspec/changes/archive/2026-09-06-channel-rotation/`,
  спека в `openspec/specs/channel-rotation/`), код в `src/features/channel-rotation/`
  и `src/scripts/periodic/channel-rotation.ts` — это деплоящийся baseline, а не
  pending change. Ввёл `countActiveChannels` (`channels.db`) и релакс инварианта
  channel-registry «assignment SHALL NOT change» → два механизма (ручной override +
  rotation). `planRotation` использует `Math.random()` тай-брейк → НЕ годится для
  R19-детерминизма channel-distribution.

- **Конфликт в спеке для будущей дельты:** `openspec/specs/channel-registry/spec.md`
  содержит требование «Round-robin assignment within a run … accumulated load is not
  taken into account» — прямо противоречит R6 channel-distribution (load-aware
  выравнивание). Разрешать разграничением областей (discovery=round-robin,
  rotation=health-spread, distribution=load-equalize — ТРИ балансировки), а не
  переписыванием discovery-требования.

**How to apply:** если задача возвращается к этой фиче или трогает
`discovered_channels`/`discovery.ts`/бота — свериться с этими находками, но
перепроверить актуальность (grep/чтение), т.к. состояние кода могло измениться.
Связано: [[project-funnel-v3-architecture]],
[[feedback-check-hidden-schema-consumers-before-renaming]].
