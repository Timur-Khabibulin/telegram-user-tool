## Why

Агент отвечает в группах, но персональное обращение в личку конвертирует в подписчика лучше. MVP проверяет эту гипотезу: агент определяет интересных авторов из групповых чатов, пишет им DM и ведёт короткий диалог.

## What Changes

- `telegram_get_messages` расширяется: возвращает `userAccessHash` для сообщений от пользователей (не min-entity)
- Новый инструмент `telegram_send_dm(userId, accessHash, text)` — отправка личного сообщения с обработкой ошибок приватности и деактивации
- Новый инструмент `telegram_get_dm_replies(entries)` — чтение входящих DM по курсору `lastAgentMsgAt`
- 8 новых DB-инструментов в `channels-db.ts` для таблиц `dm_candidates` и `dm_history`
- Существующий скилл `telegram-group-monitor/SKILL.md` дополняется этапом оценки и записи кандидатов в DM
- Два новых скилла: `dm-send` (Cron 2, раз в день) и `dm-replies` (Cron 3, каждые 30 мин)
- Регистрация двух новых крон-задач

## Capabilities

### New Capabilities

- `dm-candidates`: очередь кандидатов для DM — таблица `dm_candidates`, 4 инструмента, заполняется Cron 1
- `dm-history`: история диалогов — таблица `dm_history`, 5 инструментов (включая `dm_history_count_today`), управляет cooldown и состоянием диалогов
- `dm-send`: ежедневный скилл отправки DM — выбирает топ-кандидатов, отправляет с паузой, пишет в Saved Messages
- `dm-replies`: скилл обработки входящих DM — работает каждые 30 мин в 08:00–01:00 UTC+5, ведёт диалог до 2 обменов

### Modified Capabilities

- `group-monitoring`: существующий скилл дополняется этапом оценки сообщений (score 0.0–1.0) и записи кандидатов в `dm_candidates`

## Impact

- `src/index.ts`: новые инструменты `telegram_send_dm`, `telegram_get_dm_replies`; изменение маппинга в `telegram_get_messages`
- `src/channels-db.ts`: 8 новых инструментов, 2 новые таблицы
- `skills/telegram-group-monitor/SKILL.md`: новый этап в конце обработки каждой группы
- `skills/dm-send/SKILL.md`: новый файл
- `skills/dm-replies/SKILL.md`: новый файл
- SQLite БД агента: новые таблицы `dm_candidates` и `dm_history`
- Openclaw: 2 новые крон-задачи