## 1. Добавить инструмент tg_classify_messages в channels-db.ts

- [x] 1.1 Добавить TypeScript-типы для входных и выходных данных: `Message`, `AgentReplyRecord`, `NewThreadEntry`, `ThreadReplyEntry` в `src/channels-db.ts`
- [x] 1.2 Реализовать логику классификации: итерация по `messages`, для каждого с `replyToMsgId` вызов `findThreadByAgentMsgId`, затем `findReplyByReplyMsgId`
- [x] 1.3 Реализовать группировку `threadReplies` по `threadId` (Map<number, ThreadReplyEntry>)
- [x] 1.4 Реализовать группировку `newThreadMessages` по `replyToMsgId` (Map<number, NewThreadEntry>)
- [x] 1.5 Зарегистрировать инструмент `tg_classify_messages` через `api.registerTool` с описанием параметров через `@sinclair/typebox`
- [x] 1.6 Убедиться, что инструмент возвращает все три категории даже если они пустые (`generalMessages: []`, `newThreadMessages: []`, `threadReplies: []`)

## 2. Удалить публичную регистрацию устаревших инструментов

- [x] 2.1 Удалить блок `api.registerTool` для `tg_group_thread_find` из `src/channels-db.ts`
- [x] 2.2 Удалить блок `api.registerTool` для `tg_replies_find_by_reply_msg_id` из `src/channels-db.ts`
- [x] 2.3 Проверить, что функции `findThreadByAgentMsgId` и `findReplyByReplyMsgId` в `src/replies-db.ts` остались нетронутыми (используются внутри `tg_classify_messages`)

## 3. Обновить скилл telegram-group-monitor

- [x] 3.1 Заменить шаг 5.2.6 (ручной перебор `replyToMsgId`) на вызов `tg_classify_messages(agentId, chatId, messages)` сразу после `telegram_mark_as_read`
- [x] 3.2 Обновить шаг 5.2.7 — обработка `newThreadMessages`: принимать `NewThreadEntry[]` из классификатора; для каждого `NewThreadEntry` — создать тред через `tg_group_thread_create`, ответить, обновить тред
- [x] 3.3 Обновить шаг 5.2.8 — обработка `threadReplies`: принимать `ThreadReplyEntry[]`; обрабатывать и active, и expired треды (отвечать на оба, обновлять тред)
- [x] 3.4 Обновить шаг 5.3–5.8 — использовать только `generalMessages` из результата классификатора, убрать шаг 5.2.9 (исключение thread-replies из general messages — теперь это делает классификатор)
- [x] 3.5 Обновить таблицу инструментов в конце SKILL.md: добавить `tg_classify_messages`, убрать `tg_group_thread_find` и `tg_replies_find_by_reply_msg_id`