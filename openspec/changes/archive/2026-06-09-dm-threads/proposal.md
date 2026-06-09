## Why

Текущая реализация DM-диалогов имеет три фундаментальных ограничения: (1) потеря контекста переписки — `dm_history` хранит только первое сообщение агента, промежуточные реплики теряются; (2) искусственный лимит в 2 ответа принудительно завершает диалог, даже если пользователь заинтересован; (3) poll-модель проверки ответов — `dm-replies` на каждом прогоне перебирает все активные записи в `dm_history` и для каждой вызывает `telegram_get_dm_replies`, что даёт O(N) API-вызовов при росте базы. Замена на push-модель с полным контекстом переписки решает все три проблемы одновременно.

## What Changes

- **Новая таблица `dm_threads`** — заменяет `dm_history`, хранит полную цепочку сообщений в JSON-поле `messages` (sliding window 50 записей)
- **Новый Telegram-инструмент `telegram_get_dm_dialogs`** — возвращает список личных чатов с непрочитанными сообщениями, заполняет `peerCache` для `InputPeerUser`
- **6 новых DB-инструментов** (`dm_threads_create`, `dm_threads_get_by_users`, `dm_threads_update_msgs`, `dm_threads_count_today`, `dm_threads_exists`, `dm_threads_delete`) — полный CRUD для тредов
- **BREAKING: Удаление 5 инструментов `dm_history_*`** (`dm_history_insert`, `dm_history_count_today`, `dm_history_check_cooldown`, `dm_history_get_active`, `dm_history_update`)
- **BREAKING: Удаление `telegram_get_dm_replies`** — заменяется на `telegram_get_dm_dialogs` + `telegram_get_messages`
- **Изменение алгоритма `dm-send`**: cooldown 14 дней через `lastActivityAt` (вместо 7 дней через `sentAt`), проверка через `dm_threads_exists`, удаление истёкших тредов через `dm_threads_delete`, запись через `dm_threads_create`
- **Изменение алгоритма `dm-replies`**: push-модель (telegram_get_dm_dialogs → dm_threads_get_by_users), sentiment analysis, полный контекст переписки, без лимита ответов, mark_as_read последним
- Миграция данных не требуется — начинаем с чистого листа

## Capabilities

### New Capabilities
- `dm-threads`: Таблица `dm_threads` и 6 DB-инструментов для управления контекстными DM-диалогами (create, get_by_users, update_msgs, count_today, exists, delete)
- `dm-dialogs`: Telegram-инструмент `telegram_get_dm_dialogs` для получения личных чатов с непрочитанными сообщениями

### Modified Capabilities
- `dm-send`: Алгоритм скилла переходит на `dm_threads_*` вместо `dm_history_*`; cooldown увеличен с 7 до 14 дней; проверка cooldown по `lastActivityAt`; при истёкшем cooldown — удаление старого треда и создание нового
- `dm-replies`: Полная замена алгоритма — push-модель вместо poll; полный контекст переписки; без лимита ответов; sentiment analysis при негативе; mark_as_read последним

## Impact

- `src/index.ts` — новый инструмент `telegram_get_dm_dialogs`, удаление `telegram_get_dm_replies`
- `src/replies-db.ts` — новый файл или модификация существующего: 6 инструментов `dm_threads_*`, удаление 5 инструментов `dm_history_*`
- `skills/dm-send/SKILL.md` — обновление алгоритма
- `skills/dm-replies/SKILL.md` — полная переработка алгоритма
- `openspec/specs/dm-history/spec.md` — спецификация становится неактуальной (заменена на `dm-threads`)
- `openspec/specs/dm-replies/spec.md` — существенное обновление требований
- `openspec/specs/dm-send/spec.md` — обновление требований по cooldown и инструментам