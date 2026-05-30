## 1. БД — новые таблицы и инструменты

- [x] 1.1 Добавить в `src/replies-db.ts` функции создания таблиц `group_threads` и `group_thread_agent_msgs` (вызывать в `ensureTable`)
- [x] 1.2 Добавить в `src/replies-db.ts` функцию `findThreadByAgentMsgId(agentId, chatId, agentMsgId)` — SELECT из `group_thread_agent_msgs`
- [x] 1.3 Добавить в `src/replies-db.ts` функцию `createThread(agentId, chatId, startMsgId, messages)` — INSERT в `group_threads` + INSERT в `group_thread_agent_msgs`
- [x] 1.4 Добавить в `src/replies-db.ts` функцию `updateThread(agentId, threadId, newMessages, newAgentMsgId)` — UPDATE `group_threads` + INSERT в `group_thread_agent_msgs`
- [x] 1.5 Добавить в `src/replies-db.ts` функцию `expireOldThreads(agentId, olderThanSeconds)` — UPDATE status='expired' WHERE lastActivityAt < threshold
- [x] 1.6 Зарегистрировать инструмент `tg_group_thread_find` в `src/channels-db.ts` (параметры: agentId, chatId, agentMsgId)
- [x] 1.7 Зарегистрировать инструмент `tg_group_thread_create` в `src/channels-db.ts` (параметры: agentId, chatId, startMsgId, messages JSON)
- [x] 1.8 Зарегистрировать инструмент `tg_group_thread_update` в `src/channels-db.ts` (параметры: agentId, threadId, newMessages JSON, newAgentMsgId)
- [x] 1.9 Зарегистрировать инструмент `tg_group_thread_expire` в `src/channels-db.ts` (параметры: agentId, olderThanSeconds — дефолт 345600 = 4 дня)

## 2. Telegram — расширение telegram_get_messages

- [x] 2.1 В `src/index.ts` в инструменте `telegram_get_messages` добавить извлечение `replyToMsgId` из `m.replyTo?.replyToMsgId` для каждого сообщения
- [x] 2.2 Добавить поле `replyToMsgId?: number` в результирующий объект сообщения (только если значение присутствует)

## 3. Скилл — расширение telegram-group-monitor

- [x] 3.1 В `skills/telegram-group-monitor/SKILL.md` добавить Шаг 5.2.5 — экспирация старых тредов: вызов `tg_group_thread_expire(agentId, 345600)`
- [x] 3.2 Добавить Шаг 5.2.6 — разделение сообщений: для каждого msg с `replyToMsgId` проверить `tg_group_thread_find`; если не найдено — проверить таблицу `replies` через `tg_replies_find_by_reply_msg_id` (см. 5.2.7)
- [x] 3.3 Добавить Шаг 5.2.7 — обработка первого ответа (тред не существует): получить контекст из `replies`, вызвать `tg_group_thread_create` с messages=[T1, T2, T3], сгенерировать ответ, отправить, вызвать `tg_group_thread_update`
- [x] 3.4 Добавить Шаг 5.2.8 — обработка продолжения треда (тред существует, status='active'): добавить новые сообщения в chain, сгенерировать один ответ на все новые, отправить, вызвать `tg_group_thread_update`
- [x] 3.5 Убедиться, что thread-replies исключены из последующих шагов 5.3–5.6 (general messages flow)
- [x] 3.6 Добавить в таблицу инструментов в конце SKILL.md новые инструменты (tg_group_thread_*)

## 4. Вспомогательный инструмент для поиска по replies

- [x] 4.1 Добавить в `src/replies-db.ts` функцию `findReplyByReplyMsgId(agentId, chatId, replyMsgId)` — SELECT из `replies` WHERE chatId=? AND replyMsgId=?
- [x] 4.2 Зарегистрировать инструмент `tg_replies_find_by_reply_msg_id` в `src/channels-db.ts` (параметры: agentId, chatId, replyMsgId)

## 5. Документация для человека

- [x] 5.1 Создать директорию `docs/` если не существует
- [x] 5.2 Создать `docs/group-threads-feature.md` с PlantUML-диаграммой схемы БД (таблицы replies, group_threads, group_thread_agent_msgs и их связи)
- [x] 5.3 Добавить в `docs/group-threads-feature.md` человекочитаемое описание алгоритма работы скилла (без технических деталей кода, как для продуктового описания или онбординга)