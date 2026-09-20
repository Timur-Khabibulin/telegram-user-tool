## 1. Хранилище и модуль журнала

- [x] 1.1 Добавить `channelOperationsDbPath(adminAgentId)` в `core/config.ts` по образцу `discoveryDbPath`/`distributionDbPath` (файл `channel-operations.db` в admin-workspace).
- [x] 1.2 Создать модуль `core/db/channel-operations.ts`; реализовать `ensureChannelOperationsSchema(adminAgentId)` — идемпотентно (guard-`Set`), `CREATE TABLE IF NOT EXISTS` для `operations`, `channel_identity`, `journal_meta`; включить `PRAGMA journal_mode=WAL` и `busy_timeout`; при первом создании записать `journal_meta.started_at`.
- [x] 1.3 Создать индексы `idx_ops_chat_type_ts (chat_id,type,ts)` и `idx_ops_type_ts (type,ts)`.
- [x] 1.4 Реализовать `classifyStatusTransition(oldStatus,newStatus)` — единственное место белого списка R8 (ban / suspend / suspend_lift / leave_banned / leave_manual; иначе `null`).

## 2. Функции записи журнала

- [x] 2.1 `recordStatusChange({adminAgentId, chatId, agentId, oldStatus, newStatus, source})` — применяет `classifyStatusTransition`; `null` → no-op; иначе append операции `status_change` с `attrs` (`oldAgentId`/`newAgentId`/`oldStatus`/`newStatus`).
- [x] 2.2 `recordAssigned({adminAgentId, canonicalLink, oldAgentId, newAgentId, source})` — резолв `chatId` из `channel_identity` по ссылке (может быть NULL), append операции `assigned` с `attrs` (`oldAgentId`/`newAgentId`/`canonicalLink`).
- [x] 2.3 `recordJoined({adminAgentId, chatId, agentId, canonicalLink, source})` — append операции `joined` и upsert `channel_identity(canonical_link, chat_id)`.
- [x] 2.4 Обернуть все три функции записи в изоляцию сбоев (try/catch с логированием, best-effort) по образцу `saveChatAccessHash`.

## 3. Инструментирование смены статуса (`core/db/channels.ts`)

- [x] 3.1 `markChannelStatus`: добавить опциональный параметр `source` с дефолтом `monitor`; в транзакции прочитать текущий `status` до `UPDATE`; после коммита вызвать `recordStatusChange(old→new, source)`.
- [x] 3.2 `setLeftChannelStatus`: прочитать текущий `status` до `UPDATE`; после коммита вызвать `recordStatusChange(old→new, source='module')`.
- [x] 3.3 `expireChannelStatuses`: переработать на пообъектную обработку — выбрать истёкшие строки с их `status`, выполнить прежний сброс (в т.ч. `sleep`), затем для строк со старым статусом `suspend` вызвать `recordStatusChange(old='suspend', new=null, source='timer')`; внешнее поведение сброса сохранить.
- [x] 3.4 `upsertChannelIdentityFromJoin`: после существующего upsert идентичности вызвать `recordJoined(chatId, agentId, canonicalLink=normalizeChannelLink(channelUsername), source='module')`.

## 4. Инструментирование владения (`core/db/discovery.ts`)

- [x] 4.1 `assignChannel`: при успешном присвоении (из NULL) вызвать `recordAssigned(canonicalLink, oldAgentId=пусто, newAgentId, source)`.
- [x] 4.2 `forceAssignChannel`: прочитать прежнего `assigned_agent` в той же транзакции до `INSERT … ON CONFLICT … DO UPDATE`; после — вызвать `recordAssigned(canonicalLink, oldAgentId, newAgentId, source)`.

## 5. Прокидывание источника на точках вызова

- [x] 5.1 `core/post-comment-send.ts` (review-listener контекст): передать `source='module'` в `markChannelStatus`.
- [x] 5.2 `channel-rotation` (`forceAssignChannel`): передать `source='module'`.
- [x] 5.3 Ops-скрипты оператора (`redistribute-channels`, `distribute-pool` и т.п.), вызывающие `assignChannel`/`forceAssignChannel`: передать `source='operator'`.

## 6. Функции чтения (выгрузки)

- [x] 6.1 Запрос числа и моментов банов канала (`chatId`) у агента (R16) — фильтр `type='status_change'`, `newStatus='banned'`, `newAgentId`.
- [x] 6.2 Запрос тайм-линии владения каналом (R17) — операции `assigned` по `chatId` с мостом через `channel_identity` для записей с `chat_id=NULL`.
- [x] 6.3 Запрос агрегата банов по агенту за период (R18).
- [x] 6.4 Хелпер границы данных (R19) — сравнение начала периода с `journal_meta.started_at` и явная пометка границы в выгрузке.

## 7. Документация

- [x] 7.1 Внести журнал в `docs/db-schema.puml` (новый файл `channel-operations.db`: таблицы `operations`, `channel_identity`, `journal_meta`).
- [x] 7.2 Обновить `docs/operation.md`/`docs/README.md` при необходимости (новый файл БД в admin-workspace).
