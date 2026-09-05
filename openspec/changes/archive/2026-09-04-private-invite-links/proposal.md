## Why

`REPORT_AGENT_ID` (agent27) — единственный агент с реальным доступом и правами
администратора приватного канала прямо сейчас (проверено эмпирически:
`getPendingJoinRequests` вернул `count: 38`). `FUNNEL_ADMIN_AGENT_ID` (agent1) больше не
видит канал в диалогах вообще (`Private channel ... not found in dialogs`) — метрика
заявок для него уже молча ломается внутри общего try/catch в `funnel-collect.ts`.

Отдельно нужен канал привлечения: у выбранных оператором агентов в закреплённом посте
публичного канала (`personalChannelMessage`) должна появиться персональная инвайт-ссылка
в приватный канал с обязательным подтверждением заявки, чтобы новые заявки были
атрибутируемы по агенту-источнику.

## What Changes

- **Перенос роли администратора приватного канала** с `FUNNEL_ADMIN_AGENT_ID` на
  `REPORT_AGENT_ID`: подсчёт заявок (`getPendingJoinRequests`) в `funnel-collect.ts`
  вынесен из цикла `for (const agentId of listAgentIds())` в отдельный шаг до цикла —
  раньше он был завязан на `agentId === adminAgentId`, что стало недостижимо после
  `report-agent-isolation` (`REPORT_AGENT_ID` исключён из `listAgentIds()`, никогда не
  совпадёт с `agentId` внутри цикла). Строка снапшота в `funnel.db` остаётся под
  `agent_id = FUNNEL_ADMIN_AGENT_ID` (agent1) — непрерывность истории дельт не рвётся,
  меняется только то, чьей MTProto-сессией берётся значение.
- **Два новых метода `TelegramService`:**
  - `exportChatInvite(channelId, { title })` — инвайт-ссылка с `requestNeeded: true`,
    `title` = `agentId` целевого агента, без `usageLimit`, без `expireDate`, без
    `subscriptionPricing` (не платная).
  - `updatePersonalChannelPostLink(link)` — правит `personalChannelMessage` текущего
    аккаунта: убирает существующие строки-ссылки, добавляет новую ссылку тремя строками
    в хвост поста.
- **Новая таблица** `private_invite_links` (`agentId → link, createdAt`, PK по
  `agentId` — повторная генерация для того же агента перезаписывает) в новом файле
  `private-invites.db`, в `workspace-agent1` (тот же приём, что `funnel.db`/
  `discovery.db`).
- **Новый OpenClaw-скилл** (`skills/private-invite-links/SKILL.md` + tool
  `tg_private_invite_links` в `index.ts`) — вызывается пользователем из чата, принимает
  список `agentIds` параметром вызова (не берётся автоматически, не «все агенты»). Для
  каждого агента из списка: создаёт ссылку от имени `REPORT_AGENT_ID`, сохраняет в
  таблицу, затем от имени самого агента вставляет ссылку в его `personalChannelMessage`.
  Ошибка одного агента не прерывает обработку остальных. Хук в `tg-agent-create`
  (авто-генерация ссылки при создании нового агента) — вне скоупа, будущая работа.

## Capabilities

### New Capabilities

- `private-invite-links`: генерация персональных инвайт-ссылок с подтверждением заявки
  в приватный канал по запросу оператора, хранение реестра ссылок по агентам, вставка
  ссылки в закреплённый пост публичного канала агента.

### Modified Capabilities

- `funnel-metrics`: заявки в приватный канал собираются через `REPORT_AGENT_ID`
  (реальные права), не через `FUNNEL_ADMIN_AGENT_ID`; сбор вынесен из цикла по агентам в
  отдельный шаг, изоляция ошибок улучшена.

## Impact

- Код: `src/core/telegram/service.ts` (два новых метода), `src/core/funnel-collect.ts`
  (вынос шага заявок из цикла), `src/core/db/private-invites.ts` (новый),
  `src/core/config.ts` (`privateInvitesDbPath`), `index.ts` (новый tool
  `tg_private_invite_links`), `skills/private-invite-links/SKILL.md` (новый).
- Данные: новый файл `~/.openclaw/workspace-agent1/private-invites.db`. Без миграции
  существующих данных (`funnel.db` продолжает расти под тем же `agent_id`).
- Не в скоупе: автогенерация ссылки при создании нового агента (хук в
  `tg-agent-create`) — зафиксировано как future work.
