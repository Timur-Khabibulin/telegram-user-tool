## Why

LLM-агент в скилле `telegram-group-monitor` должен самостоятельно проверять поле `replyToMsgId` в каждом входящем сообщении и делать 1–2 DB-запроса на каждое сообщение, чтобы определить его категорию. На практике LLM систематически пропускает этот шаг — не замечает поле в массиве из десятков сообщений, вызывает инструменты выборочно или в неправильном порядке, что приводит к потере thread-replies и некорректному поведению агента.

## What Changes

- **NEW** инструмент `tg_classify_messages` в `src/channels-db.ts` — принимает сырые сообщения из `telegram_get_messages` и возвращает три категории: `generalMessages`, `newThreadMessages`, `threadReplies`. Все DB-запросы выполняются внутри инструмента, LLM получает уже классифицированный результат.
- **REMOVED** публичный инструмент `tg_group_thread_find` — его логика переезжает внутрь `tg_classify_messages`.
- **REMOVED** публичный инструмент `tg_replies_find_by_reply_msg_id` — его логика переезжает внутрь `tg_classify_messages`.
- **MODIFIED** скилл `telegram-group-monitor/SKILL.md` — шаги 5.2.6 (разделение сообщений на потоки) упрощаются: LLM вызывает `tg_classify_messages` вместо двух ручных DB-запросов. **BREAKING**: публичные инструменты `tg_group_thread_find` и `tg_replies_find_by_reply_msg_id` перестают регистрироваться в plugin API.

## Capabilities

### New Capabilities

- `message-classification`: Инструмент `tg_classify_messages`, который классифицирует входящие Telegram-сообщения на три категории на основе DB-запросов к `tg_group_threads` и `tg_replies`, скрывая детали реализации от LLM.

### Modified Capabilities

- `group-monitoring`: Обновляется алгоритм шага 5.2.6 скилла — LLM вызывает `tg_classify_messages` вместо прямых обращений к `tg_group_thread_find` и `tg_replies_find_by_reply_msg_id`.

## Impact

- `src/channels-db.ts` — добавить `tg_classify_messages`, удалить регистрацию `tg_group_thread_find` и `tg_replies_find_by_reply_msg_id` из `registerTool`
- `skills/telegram-group-monitor/SKILL.md` — переписать шаги 5.2.6–5.2.9
- Внутренние функции `findThreadByAgentMsgId` и `findReplyByReplyMsgId` из `src/replies-db.ts` остаются, используются внутри нового инструмента
- Агенты, у которых в промптах упоминаются удалённые инструменты напрямую, перестанут их находить через function calling