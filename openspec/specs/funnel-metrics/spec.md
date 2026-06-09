# funnel-metrics Specification

## Purpose
TBD - created by archiving change funnel-tracking. Update Purpose after archive.
## Requirements
### Requirement: Обнаружение агентов

Система SHALL в начале каждого прогона динамически получать список агентов через `listAgentIds()` (каталоги `~/.openclaw/workspace-<agentId>/`) и собирать метрики по каждому из них.

#### Scenario: Появился новый агент

- **WHEN** в `~/.openclaw/` присутствует каталог `workspace-agentN`, ранее не существовавший
- **THEN** при следующем прогоне agentN включается в сбор метрик без изменения конфигурации

#### Scenario: Агентов нет

- **WHEN** `listAgentIds()` возвращает пустой список
- **THEN** прогон завершается без ошибок и без записи снапшотов

### Requirement: Обнаружение публичного канала агента

Система SHALL определять публичный канал агента автоматически как канал, закреплённый в профиле аккаунта (personal channel), через `users.GetFullUser(self)` (`personalChannelId` + `personalChannelMessage`), используя `access_hash` из массива `chats` ответа. Если у агента не задан personal channel, агент SHALL быть пропущен с пометкой.

#### Scenario: У агента задан personal channel

- **WHEN** `GetFullUser` возвращает непустой `personalChannelId`
- **THEN** система использует этот канал и `personalChannelMessage` как id поста для метрик охвата

#### Scenario: У агента нет personal channel

- **WHEN** `GetFullUser` возвращает пустой `personalChannelId`
- **THEN** агент пропускается с пометкой в отчёте, прогон остальных агентов продолжается

### Requirement: Метрики активности из БД агента

Система SHALL за завершившийся день UTC+5 считать по каждому агенту число ответов в группах (COUNT `replies.sentAt` из `tg-replies.db`) и число личных сообщений (COUNT `dm_history.sentAt` из `tg-channels.db`), открывая эти две БД как отдельные подключения.

#### Scenario: Подсчёт за день

- **WHEN** прогон считает метрики за день UTC+5
- **THEN** `group_replies` равен числу строк `replies` с `sentAt` в окне дня, а `dms_sent` — числу строк `dm_history` с `sentAt` в том же окне

#### Scenario: БД агента отсутствует или недоступна

- **WHEN** одна из БД агента отсутствует или не читается
- **THEN** соответствующая метрика берётся как 0 либо агент пропускается с пометкой, прогон не падает

### Requirement: Снапшот охвата публичного канала

Система SHALL снимать снапшот просмотров поста (`messages.GetMessagesViews` по `personalChannelMessage`) и числа подписчиков (`channels.GetFullChannel.participantsCount`) публичного канала каждого агента раз в день и сохранять абсолютные значения в `channel_snapshots`.

#### Scenario: Успешный снапшот охвата

- **WHEN** публичный канал агента определён
- **THEN** в `channel_snapshots` записываются `post_id`, `post_views`, `public_channel_subs` с текущим `snapped_at`

### Requirement: Снапшот заявок в приватный канал

Система SHALL через аккаунт agent1 снимать число неодобренных заявок на вступление в приватный канал (`messages.GetChatInviteImporters(peer, requested=true)` → длина списка) и сохранять его в `channel_snapshots.private_pending_requests`. ID приватного канала задаётся аргументом запуска `--private-channel <id>`, `access_hash` резолвится из `getDialogs` agent1. При отсутствии прав (`CHAT_ADMIN_REQUIRED`) метрика заявок SHALL быть пропущена с пометкой, прогон не падает.

#### Scenario: agent1 имеет право invite_users

- **WHEN** agent1 — админ приватного канала с правом `invite_users`
- **THEN** число pending-заявок записывается в `private_pending_requests` снапшота agent1

#### Scenario: У agent1 недостаточно прав

- **WHEN** `GetChatInviteImporters` возвращает `CHAT_ADMIN_REQUIRED`
- **THEN** заявки помечаются недоступными в отчёте, остальные метрики собираются как обычно

#### Scenario: Прочие агенты

- **WHEN** собираются метрики агента, отличного от agent1
- **THEN** `private_pending_requests` для него равен NULL

### Requirement: Хранение снапшотов и дневных агрегатов

Система SHALL хранить сырые снапшоты в таблице `channel_snapshots` и предвычисленные дневные агрегаты в таблице `daily_stats` в БД `~/.openclaw/workspace-agent1/funnel.db`, создавая схему идемпотентно (`CREATE TABLE IF NOT EXISTS`).

#### Scenario: Первый прогон

- **WHEN** `funnel.db` ещё не существует
- **THEN** таблицы `channel_snapshots` и `daily_stats` создаются, прогон записывает данные без ошибки

### Requirement: Вычисление дневных дельт

Система SHALL вычислять дельту метрики как разность текущего снапшота и предыдущего снапшота того же `agent_id` и сохранять в `daily_stats` и дельту, и абсолютное значение (`*_delta` и `*_abs`).

#### Scenario: Есть предыдущий снапшот

- **WHEN** для агента существует снапшот за предыдущий день
- **THEN** `post_views_delta`/`public_subs_delta`/`private_requests_delta` равны разности текущего и предыдущего значений, а `*_abs` — текущим значениям

#### Scenario: Предыдущего снапшота нет

- **WHEN** это первый снапшот агента
- **THEN** дельта равна 0 (или помечается как недоступная), `*_abs` заполняется текущим значением

### Requirement: Защита от двойного прогона

Система SHALL перед записью снапшота проверять наличие снапшота того же `agent_id` с `snapped_at` в пределах текущего дня UTC+5 и при наличии SHALL пропускать повторную запись, не дублируя данные.

#### Scenario: Повторный запуск в тот же день

- **WHEN** скрипт запускается повторно в пределах одного дня UTC+5
- **THEN** новые снапшоты за этот день не добавляются, данные не дублируются

### Requirement: Изоляция сбоев по агенту

Система SHALL обрабатывать сбор по каждому агенту изолированно: ошибка подключения, прокси, MTProto или БД одного агента SHALL приводить к его пропуску с пометкой, не прерывая прогон остальных.

#### Scenario: Один агент недоступен

- **WHEN** при сборе по agentK возникает исключение (мёртвая сессия/прокси/таймаут)
- **THEN** agentK пропускается с пометкой, метрики остальных агентов собираются и записываются

