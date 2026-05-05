## ADDED Requirements

### Requirement: dm_history table exists
Таблица `dm_history` SHALL быть создана в БД агента при первом write-вызове через `CREATE TABLE IF NOT EXISTS`. Колонки: `id`, `userId`, `userAccessHash`, `username`, `triggerText`, `dmText`, `sentAt`, `lastAgentMsgAt`, `replyCount`, `status`.

#### Scenario: First insert creates table
- **WHEN** `dm_history_insert` вызывается на чистой БД
- **THEN** таблица создаётся автоматически и запись вставляется

### Requirement: Cooldown check prevents repeated DM
`dm_history_check_cooldown` SHALL возвращать `true` (можно писать), если у пользователя нет записи с `sentAt > now - 7 * 86400`. Иначе — `false`.

#### Scenario: No recent DM — cooldown clear
- **WHEN** у пользователя нет записей в `dm_history` или последняя запись старше 7 дней
- **THEN** возвращается `true`

#### Scenario: Recent DM — cooldown active
- **WHEN** у пользователя есть запись с `sentAt` в пределах последних 7 дней
- **THEN** возвращается `false`

### Requirement: Daily DM count retrievable
`dm_history_count_today` SHALL возвращать количество записей с `sentAt > полночь UTC текущего дня`.

#### Scenario: Count reflects today's sends
- **WHEN** сегодня были отправлены N DM (N записей с `sentAt` после полуночи UTC)
- **THEN** `dm_history_count_today` возвращает N

### Requirement: Active dialogues retrievable
`dm_history_get_active` SHALL возвращать все записи со статусом `sent` или `in_dialogue`, включая поля `id`, `userId`, `userAccessHash`, `username`, `triggerText`, `dmText`, `lastAgentMsgAt`, `replyCount`.

#### Scenario: Returns only active statuses
- **WHEN** таблица содержит записи со статусами `sent`, `in_dialogue`, `done`, `privacy_blocked`
- **THEN** возвращаются только записи со статусами `sent` и `in_dialogue`

### Requirement: Dialogue record updated
`dm_history_update` SHALL обновлять указанные поля записи по `id`. Поддерживаемые поля: `status`, `replyCount`, `lastAgentMsgAt`, `username`.

#### Scenario: Status and replyCount updated
- **WHEN** `dm_history_update(agentId, id, { status: 'in_dialogue', replyCount: 1, lastAgentMsgAt: now })`
- **THEN** запись с этим `id` отражает новые значения
