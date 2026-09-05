## 1. Сервис: выход из канала и резолв username

- [x] 1.1 Добавить `leaveChannel(chatId)` в `src/core/telegram/service.ts` (MTProto `channels.LeaveChannel`, резолв inputChannel из `chatId`)
- [x] 1.2 Добавить резолв `chatId → username` (через `GetFullChannel`), возвращающий username или null

## 2. Модель данных: очередь `banned_channels`

- [x] 2.1 Добавить схему `banned_channels` (`chatId` PK, `detectedAt`) в `src/core/db/channels.ts` (`CREATE TABLE IF NOT EXISTS`)
- [x] 2.2 Добавить `enqueueBannedChannel(agentId, chatId, log)` (`INSERT OR IGNORE`)
- [x] 2.3 Добавить `getBannedChannels(agentId)` и `deleteBannedChannel(agentId, chatId)`

## 3. Модель данных: полная чистка по `chatId`

- [x] 3.1 Добавить `purgeChannelData(agentId, chatId, log)` в `src/core/db/channels.ts` — удаляет `channels`, `channel_visits`, `dm_candidates` (по `sourceChatId`) в `tg-channels.db`
- [x] 3.2 Удалить из `tg-replies.db`: `replies`, `group_threads`, `group_thread_agent_msgs` по `chatId` (функция в `replies.ts`, вызывается из `purgeChannelData` или рядом)
- [x] 3.3 Убедиться, что `send_errors` и `dm_threads` НЕ затрагиваются

## 4. Реестр: пометка бана

- [x] 4.1 Добавить колонку `banned_at INTEGER` в `discovered_channels` (аддитивная миграция `ALTER TABLE`, как `added_at`)
- [x] 4.2 Добавить `markChannelBanned(adminAgentId, canonicalLink, bannedAt)` (`UPDATE … SET banned_at`, `assigned_agent` не трогать)

## 5. Монитор: детект CHAT_WRITE_FORBIDDEN

- [x] 5.1 В обёртке `sendReply` (`monitor.ts`) различать `CHAT_WRITE_FORBIDDEN` отдельно от прочих не-flood ошибок
- [x] 5.2 Для `CHAT_WRITE_FORBIDDEN` вызвать `enqueueBannedChannel` (помимо существующих `recordSendError` + пропуск канала)
- [x] 5.3 Проверить, что прочие не-flood ошибки и `FloodAbortError` ведут себя как прежде

## 6. Скилл `leave-banned-channels`

- [x] 6.1 Создать `src/skills/leave-banned-channels.ts` — `(ctx) => SkillStatus`: загрузить аккаунт, прочитать `banned_channels`
- [x] 6.2 Для каждого `chatId`: resolve username → `leaveChannel` → при успехе `purgeChannelData` → пометка реестра (если username есть) → `deleteBannedChannel`
- [x] 6.3 При ошибке `leaveChannel` — не чистить/не помечать, оставить строку в очереди, перейти к следующему
- [x] 6.4 Вернуть статус-модель (обработано/пропущено/ошибки)
- [x] 6.5 Зарегистрировать скилл в `src/scripts/dispatcher.ts` (SKILLS) и завести `TaskType`
- [x] 6.6 Добавить тип `leave-banned` в пульт расписания: `taskTypeParam` enum в `index.ts` (`tg_scheduler_upsert_task`) и таблицы типов/дефолтов в `skills/scheduler-control/SKILL.md` (дефолт `0 5 * * *` Asia/Yekaterinburg)

## 7. Проверка
