## 1. Схема данных

- [x] 1.1 Добавить в таблицу `channels` колонки `write_access_reason` (TEXT NULL) и `write_access_until` (INTEGER NULL); аддитивная миграция (существующие строки — NULL, без бэкфилла)
- [x] 1.2 В `src/core/db/channels.ts` — функции чтения/записи признака: `setWriteAccessReason(agentId, chatId, reason, until?)`, `clearWriteAccessReason(agentId, chatId)`, и включение полей в выборку канала

## 2. Классификация (чистый модуль)

- [x] 2.1 Создать `src/core/write-access.ts`: тип `WriteAccessReason`, `isPermanentReason(reason)` (`∈ {members_restricted, paid}`), `classifyParticipant(participant)` (статус `GetParticipant`/`USER_NOT_PARTICIPANT` → причина или null), `classifySendError(errorTag)` (код send-ошибки → причина или null), `classifyDefaultBannedRights(defaultBannedRights)` (постоянная величина при вступлении)
- [x] 2.2 Юнит-тест модуля (`node --test`): все ветки перечня причин, разбор `channelParticipantBanned` (`left`/`send_messages`), `not_participant`, `paid`, голый `CHAT_WRITE_FORBIDDEN`, исключения `slowmode`/`PEER_FLOOD`

## 3. Захват постоянной величины при вступлении

- [x] 3.1 В tg-слое (`src/core/telegram/service.ts`/`join`-путь) пробросить `default_banned_rights` группы обсуждения из уже делаемого `GetFullChannel` в результат вступления (напр. поле `defaultBannedSendMessages` в идентичности join)
- [x] 3.2 В `src/skills/join-queue.ts` при успешном join через `classifyDefaultBannedRights` записывать `write_access_reason='members_restricted'` либо оставлять пусто; согласовать с self-heal (повторный успешный join перезаписывает признак)

## 4. Проверка перед отправкой и реактивный резерв (monitor-v5)

- [x] 4.1 В `src/skills/monitor-v5.ts` перед фазой отправок канала (шаг 5.3c) выполнять живой `GetParticipant(self)` (раз на канал за прогон) через существующую обёртку; по `classifyParticipant` при переменной причине — записать причину, поставить `status='banned'` (вход в leave/rotate), пропустить фазу отправок; при `can_write` со снятием ранее стоявшей причины — очистить признак
- [x] 4.2 При постоянной причине (в т.ч. пришедшей из join) — не ставить `status='banned'`, оставить канал read-only (чтение/DM продолжаются), отправки не инициировать
- [x] 4.3 В общем обработчике отправки `src/core/post-comment-send.ts` (`handlePostCommentSendError`, реактивный дом v5) дополнить ветки ошибок: `classifySendError` пишет причину; `allow_payment_required` → `write_access_reason='paid'` вместо `status='format_error'`; существующая простановка `status='banned'` для `chat_write_forbidden`/`user_banned_in_channel` сохраняется
- [x] 4.4 Убедиться, что после первого отказа остальные отправки в канал за прогон не идут (существующий `ChannelSkipError` + пропуск фазы) — при необходимости зафиксировать поведение тестом/проверкой

## 5. Проверка

- [x] 5.2 Обновить документацию при расхождении (`docs/telegram-errors.md` по ветке `allow_payment_required`, если менялось поведение), сверить с `docs/design/channel-write-access/`

## 6. Причина бана в истории операций (channel-operations-history)

- [x] 6.1 Проброс причины: добавить необязательный параметр `writeAccessReason` в `markChannelStatus` (`src/core/db/channels.ts`) → передать в `recordStatusChange` → положить в `attrs.reason` события `status_change` (только когда передан; схему `operations` не менять — расширяем JSON `attrs`)
- [x] 6.2 Ban-сайты передают причину: precheck `monitor-v5` (§5.3c) и `handlePostCommentSendError` (`src/core/post-comment-send.ts`) передают в `markChannelStatus('banned', …)` ту же причину, что пишут в `setWriteAccessReason`
- [x] 6.3 Чтение/аналитика: разрез банов по причине из журнала (`json_extract(attrs,'$.reason')`) — расширить `aggregateBansByAgent` или добавить `aggregateBansByReason(start,end)` в `channel-operations.ts`
- [x] 6.4 Проверка: событие бана в `channel-operations.db` несёт `attrs.reason` для переменных причин; для банов вне пути права записи `reason` отсутствует; дедуп `banned→banned` сохранён
