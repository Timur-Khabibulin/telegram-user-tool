## ADDED Requirements

### Requirement: Очередь забаненных каналов

Система SHALL хранить per-agent очередь каналов с `CHAT_WRITE_FORBIDDEN` в
таблице `banned_channels` (`tg-channels.db`) с ключом `chatId` и временем
обнаружения. Постановка в очередь SHALL быть идемпотентной (`INSERT OR IGNORE`):
повторная ошибка по тому же каналу не создаёт дубль.

#### Scenario: Канал ставится в очередь один раз

- **WHEN** монитор дважды получает `CHAT_WRITE_FORBIDDEN` для одного `chatId` до обработки очереди
- **THEN** в `banned_channels` существует ровно одна строка с этим `chatId`

#### Scenario: Очередь создаётся при первом обращении

- **WHEN** запись в `banned_channels` происходит впервые (таблицы ещё нет)
- **THEN** таблица создаётся идемпотентно, запись выполняется без ошибки

### Requirement: Выход из забаненного канала

Скилл `leave-banned-channels` SHALL для каждого `chatId` из `banned_channels`
выходить из канала через `leaveChannel` (MTProto `channels.LeaveChannel`) до
удаления данных. Если выход завершился ошибкой, система SHALL не удалять данные и
не помечать реестр, оставив строку в очереди для повторной обработки.

#### Scenario: Успешный выход предшествует удалению

- **WHEN** скилл обрабатывает `chatId` из очереди и `leaveChannel` успешен
- **THEN** далее выполняются удаление данных агента и (при возможности) пометка реестра

#### Scenario: Выход не удался — обработка откладывается

- **WHEN** `leaveChannel` для `chatId` завершается ошибкой
- **THEN** данные не удаляются, реестр не помечается, строка остаётся в `banned_channels`

### Requirement: Полное удаление рабочих данных агента по каналу

После успешного выхода система SHALL удалять рабочие данные агента по `chatId`:
из `tg-channels.db` — `channels`, `channel_visits`, `dm_candidates` (по
`sourceChatId`); из `tg-replies.db` — `replies`, `group_threads`,
`group_thread_agent_msgs`. Система SHALL НЕ удалять `send_errors` (история для
отчёта) и `dm_threads` (активные личные диалоги). Строка `banned_channels` SHALL
удаляться последней.

#### Scenario: Канальные данные удалены, история и личные диалоги сохранены

- **WHEN** скилл обработал забаненный `chatId`
- **THEN** строки `channels`/`channel_visits`/`dm_candidates`/`replies`/`group_threads`/`group_thread_agent_msgs` по этому `chatId` удалены, а строки `send_errors` по этому `chatId` и `dm_threads` с `fromChatId = chatId` сохранены

#### Scenario: Очередь самоочищается

- **WHEN** удаление данных по `chatId` завершено
- **THEN** строка с этим `chatId` удалена из `banned_channels`

### Requirement: Канал не возвращается после выхода

После выхода и удаления данных система SHALL НЕ возвращать канал в данные агента
при следующей синхронизации диалогов (`syncChannels`), поскольку агент больше не
участник канала.

#### Scenario: Синхронизация не восстанавливает забаненный канал

- **WHEN** после обработки забаненного канала выполняется очередной прогон монитора с `syncChannels`
- **THEN** канал не появляется снова в таблице `channels`

### Requirement: Пометка бана в реестре

Система SHALL резолвить `chatId` в `canonical_link` (через `GetFullChannel.username`,
best-effort) и при успехе помечать строку `discovered_channels` колонкой
`banned_at` (unix-сек), сохраняя `assigned_agent` и саму строку. Если username
не резолвится, система SHALL пропустить пометку реестра, не прерывая выход и
удаление данных.

#### Scenario: Username резолвится — реестр помечен

- **WHEN** `chatId` резолвится в известный `canonical_link`
- **THEN** у соответствующей строки `discovered_channels` проставлен `banned_at`, `assigned_agent` не изменён, строка не удалена

#### Scenario: Username не резолвится — выход всё равно выполнен

- **WHEN** у `chatId` нет публичного username
- **THEN** выход из канала и удаление данных агента выполнены, пометка реестра пропущена
