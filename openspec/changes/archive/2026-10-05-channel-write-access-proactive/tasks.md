## 1. Классификация (write-access.ts)

- [x] 1.1 Определить типы `WriteAccessSnapshot`, `DetectedStatus`, `WriteAccessAction` (design.md §2.1–2.2)
- [x] 1.2 Реализовать чистую `classifyWriteAccess(snapshot) → action` с порядком разбора по приоритету «уровень канала → уровень аккаунта» (design.md §2.3)
- [x] 1.3 Перенести разбор `ChatBannedRights` (инверсия `send_messages`, `normalizeUntil`) в разбор снимка; удалить `classifyParticipant`/`isPermanentReason`/`classifyDefaultBannedRights`/`classifySendError` и тип `WriteAccessReason`

## 2. Снимок статусов (telegram/service.ts)

- [x] 2.1 Расширить `getSelfParticipant`: вернуть `WriteAccessSnapshot` — статус участника + флаги группы обсуждения (`buildDiscussionFlags`) из ответа `GetParticipant`
- [x] 2.2 Нормализовать служебные ошибки вызова в `kind`: `USER_NOT_PARTICIPANT`/`USER_BANNED_IN_CHANNEL`/`CHANNEL_PRIVATE`(→`forbidden`); `forbidden`→авторотация (`channel_forbidden`)
- [x] 2.3 Доступ broadcast покрыт без отдельного кэша: потеря доступа → реактивно 5.3 (`CHANNEL_PRIVATE`→авторотация); `broadcast.restricted` (читаемый) проактивно НЕ гейтит — комментирование определяется группой обсуждения (её `restricted` проверяется). R2/AC уточнены соответственно

## 3. Журнал операций (db/channel-operations.ts)

- [x] 3.1 Добавить `OperationType='write_access'` и тип `WriteAccessEventPayload`
- [x] 3.2 Реализовать `recordWriteAccessEvent(...)` (best-effort) со статусом/уровнем/действием + payload

## 4. Действия на существующих механизмах (db/channels.ts)

- [x] 4.1 `setWriteAccessReason`/`clearWriteAccessReason` удалены (колонки создаёт `migrateWriteAccessColumns` в `initChannels`, читает `getChannelsBatch`/пишет NULL `upsertChannelIdentityFromJoin`). Колонки — мёртвые, без миграции-дропа
- [x] 4.2 `markChannelStatus('suspend', durationSeconds?, description?)` используется для бессрочного (restricted/members_restricted/paid) и временного (slowmode) suspend; `restriction_reason` сериализуется в `status_description`

## 5. Интеграция в monitor-v5 (skills/monitor-v5.ts)

- [x] 5.1 В precheck (5.3c) `classifyParticipant` заменён на снимок + `classifyWriteAccess`; действие применяется (autorotate→banned, suspend, join/join_request→banned как §12.5) + `recordWriteAccessEvent`; вызывается только при `hasSendWork`
- [x] 5.2 Переход к следующему каналу после применённого действия (одна попытка на канал за прогон)
- [x] 5.3 Обе read-time ветки `CHANNEL_PRIVATE` (getPeerDialog + getMessages) → авторотация (`markChannelStatus('banned', …, "channel_forbidden")`) + `recordWriteAccessEvent`, вместо `not_found` (`monitor-v5-hash-driven-sync` заархивирован)

## 6. Реактивный резерв (post-comment-send.ts)

- [x] 6.1 Ветки переведены на действие + `recordWriteAccessEvent`: `chat_write_forbidden`/`user_banned_in_channel`→авторотация; `allow_payment_required`→бессрочный suspend (вместо `format_error`)
- [x] 6.2 Без изменений: `slowmode` (ретрай), `peer_flood` (уровень аккаунта), `chat_send_plain/media_forbidden` (`format_error`)

## 7. Согласование

- [x] 7.1 Все действия идут через `markChannelStatus` — dual-write `membership` (`tg-peer-identity-model`) не дублируется
- [x] 7.2 `participant-rights-model.puml` note выровнен под action-модель, PNG перерисован (Smetana)
