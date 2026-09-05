# dm-candidates Specification

## Purpose

Хранение и обработка очереди кандидатов на личные сообщения (DM) — вставка
без дублей, выборка по `score`, обновление статуса, устаревание старых
записей.

## Requirements

### Requirement: dm_candidates table exists
Таблица `dm_candidates` SHALL быть создана в БД агента (`tg-channels.db`) при первом write-вызове через `CREATE TABLE IF NOT EXISTS`.

#### Scenario: First insert creates table
- **WHEN** `dm_candidates_insert` вызывается на чистой БД
- **THEN** таблица создаётся автоматически и запись вставляется

### Requirement: Candidate inserted without duplicates
`dm_candidates_insert` SHALL вставлять кандидата, игнорируя дубли по `(sourceChatId, msgId)`.

#### Scenario: Duplicate message ignored
- **WHEN** `dm_candidates_insert` вызывается дважды с одинаковыми `sourceChatId` и `msgId`
- **THEN** вторая вставка игнорируется, ошибки нет, в таблице одна запись

#### Scenario: Different message inserted
- **WHEN** `dm_candidates_insert` вызывается с уникальной парой `(sourceChatId, msgId)`
- **THEN** запись вставляется со статусом `pending`

### Requirement: Pending candidates retrieved sorted by score
`dm_candidates_get_pending` SHALL возвращать записи со статусом `pending`, отсортированные по `score DESC`, не более `limit` штук.

#### Scenario: Returns only pending
- **WHEN** таблица содержит записи со статусами `pending`, `sent`, `skipped`, `expired`
- **THEN** возвращаются только записи со статусом `pending`

#### Scenario: Sorted by score descending
- **WHEN** несколько `pending`-записей с разными `score`
- **THEN** возвращаются в порядке убывания `score`

### Requirement: Status updated individually
`dm_candidates_update_status` SHALL обновлять статус одной записи по `id`.

#### Scenario: Status changed to sent
- **WHEN** `dm_candidates_update_status(agentId, id, 'sent')` вызывается
- **THEN** запись с этим `id` имеет статус `sent`

### Requirement: Old pending records expired
`dm_candidates_expire_old` SHALL переводить в статус `expired` только записи со статусом `pending`, где `createdAt < now - olderThanDays * 86400`.

#### Scenario: Only old pending records expired
- **WHEN** `dm_candidates_expire_old(agentId, 3)` вызывается
- **THEN** только `pending`-записи старше 3 дней переходят в `expired`; записи со статусами `sent`, `skipped` и новые `pending` не затрагиваются
