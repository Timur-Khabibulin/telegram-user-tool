## MODIFIED Requirements

### Requirement: Снапшот заявок в приватный канал

Система SHALL через аккаунт `REPORT_AGENT_ID` (администратор приватного канала) снимать
число неодобренных заявок на вступление в приватный канал
(`messages.GetChatInviteImporters(peer, requested=true)` → длина списка) и сохранять его
в `channel_snapshots.private_pending_requests`. Сбор SHALL выполняться одним отдельным
шагом до обхода `listAgentIds()`, не внутри цикла по агентам — `REPORT_AGENT_ID`
исключён из `listAgentIds()` (`report-agent-isolation`) и не может быть одной из
итераций цикла. Полученное значение SHALL сохраняться в строке снапшота
`agent_id = FUNNEL_ADMIN_AGENT_ID` — владелец `funnel.db` не меняется, меняется только
то, чьей MTProto-сессией берётся значение. ID приватного канала задаётся аргументом
запуска `--private-channel <id>`, `access_hash` резолвится из `getDialogs`
`REPORT_AGENT_ID`. При отсутствии прав (`CHAT_ADMIN_REQUIRED`) или недоступности канала
метрика заявок SHALL быть пропущена с пометкой, прогон остальных метрик не прерывается.

#### Scenario: REPORT_AGENT_ID имеет право invite_users

- **WHEN** `REPORT_AGENT_ID` — админ приватного канала с правом `invite_users`
- **THEN** число pending-заявок записывается в `private_pending_requests` снапшота с `agent_id = FUNNEL_ADMIN_AGENT_ID`

#### Scenario: У REPORT_AGENT_ID недостаточно прав или канал недоступен

- **WHEN** запрос заявок завершается `CHAT_ADMIN_REQUIRED` или каналом не найден в диалогах
- **THEN** заявки помечаются недоступными в отчёте, остальные метрики (этапы 1-4, 5-6 по всем агентам) собираются как обычно — сбой этого шага их не затрагивает

#### Scenario: Сбор не привязан к обходу агентов

- **WHEN** система строит отчёт-воронку
- **THEN** сбор заявок выполняется один раз, до начала цикла по `listAgentIds()`, независимо от того, сколько агентов и в каком порядке обходятся дальше
