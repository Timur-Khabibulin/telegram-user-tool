## 1. DB-инструменты dm_threads (src/replies-db.ts)

- [x] 1.1 Создать таблицу `dm_threads` с полной схемой: `id`, `userId` (UNIQUE), `userAccessHash`, `userName`, `fromChatId`, `triggerMessage`, `messages` (JSON), `createdAt`, `lastActivityAt`; индексы `idx_dm_threads_created` и `idx_dm_threads_activity`
- [x] 1.2 Реализовать `dm_threads_create(userId, userAccessHash, userName, fromChatId, triggerMessage, firstMessage)` — создание треда с первым сообщением агента в `messages` JSON
- [x] 1.3 Реализовать `dm_threads_get_by_users(users: [{userId, accessHash, userName}])` — поиск тредов с обновлением `userAccessHash`/`userName` в одной транзакции, возврат `{threads, notFound}`
- [x] 1.4 Реализовать `dm_threads_update_msgs(userId, newMessages)` — дописать сообщения в `messages` JSON, обновить `lastActivityAt`, sliding window 50 записей с логированием при обрезке
- [x] 1.5 Реализовать `dm_threads_count_today()` — подсчёт тредов с `createdAt >= полночь UTC`
- [x] 1.6 Реализовать `dm_threads_exists(userId)` — проверка наличия треда с вычислением cooldown (14 дней по `lastActivityAt`), возврат `{exists, cooldownActive, days}`
- [x] 1.7 Реализовать `dm_threads_delete(userId)` — удаление треда, идемпотентная операция

## 2. Удаление старых DB-инструментов dm_history (src/replies-db.ts)

- [x] 2.1 Удалить инструмент `dm_history_insert`
- [x] 2.2 Удалить инструмент `dm_history_count_today`
- [x] 2.3 Удалить инструмент `dm_history_check_cooldown`
- [x] 2.4 Удалить инструмент `dm_history_get_active`
- [x] 2.5 Удалить инструмент `dm_history_update`

## 3. Telegram-инструмент telegram_get_dm_dialogs (src/index.ts)

- [x] 3.1 Реализовать `telegram_get_dm_dialogs()` — запрос `GetDialogs` с фильтром по типу `User` и `unreadCount > 0`, возврат `{dms: [{userId, accessHash, userName, firstName, unreadCount, readInboxMaxId}]}`
- [x] 3.2 Заполнять `peerCache` записью `InputPeerUser` для каждого возвращённого пользователя

## 4. Удаление старого Telegram-инструмента (src/index.ts)

- [x] 4.1 Удалить инструмент `telegram_get_dm_replies`

## 5. Скилл dm-send (skills/dm-send/SKILL.md)

- [x] 5.1 Заменить `dm_history_count_today` на `dm_threads_count_today` в проверке дневного лимита (>= 15)
- [x] 5.2 Заменить `dm_history_check_cooldown` на `dm_threads_exists` с тремя ветками: `cooldownActive: true` → skip, `cooldownActive: false` → `dm_threads_delete` + продолжить, `exists: false` → продолжить
- [x] 5.3 Заменить `dm_history_insert` на `dm_threads_create` при успешной отправке DM (с `firstMessage` содержащим `{role: "agent", msgId, text, sentAt}`)
- [x] 5.4 Обновить описание cooldown: 14 дней по `lastActivityAt` вместо 7 дней по `sentAt`

## 6. Скилл dm-replies (skills/dm-replies/SKILL.md)

- [x] 6.1 Заменить шаг `dm_history_get_active` + `telegram_get_dm_replies` на push-модель: `telegram_get_dm_dialogs` → `dm_threads_get_by_users`
- [x] 6.2 Добавить обработку `notFound` из `dm_threads_get_by_users` — игнорировать DM от пользователей без тредов
- [x] 6.3 Заменить `telegram_get_dm_replies` на `telegram_get_messages(chatId=userId, minId=<последний msgId>)` для получения новых сообщений
- [x] 6.4 Добавить шаг sentiment analysis (LLM) перед генерацией ответа: `positive` → продолжить, `negative` → `mark_as_read` + skip
- [x] 6.5 Обновить генерацию ответа LLM: передавать `triggerMessage` + полную цепочку `thread.messages` (до 50) + новые сообщения
- [x] 6.6 Заменить `dm_history_update` на `dm_threads_update_msgs(userId, newMessages)` с массивом всех новых сообщений (user + agent)
- [x] 6.7 Перенести `telegram_mark_as_read` на последний шаг обработки каждого пользователя (после send + update)
- [x] 6.8 Убрать искусственный лимит в 2 ответа (`replyCount`, `status = done`) — тред живёт пока есть активность
- [x] 6.9 Добавить обработку ошибок `telegram_send_dm`: `privacy_blocked` → mark_as_read + skip, `flood_wait` → прервать прогон, `peer_id_invalid` → mark_as_read + skip

## 7. Обновление спецификаций OpenSpec

- [x] 7.1 Убедиться, что `openspec/specs/dm-send/spec.md` отражает новый алгоритм (при архивации change)
- [x] 7.2 Убедиться, что `openspec/specs/dm-replies/spec.md` отражает новый алгоритм (при архивации change)
