## ADDED Requirements

### Requirement: dm_threads table exists
Таблица `dm_threads` SHALL быть создана в БД агента при первом вызове любого `dm_threads_*` инструмента через `CREATE TABLE IF NOT EXISTS`. Колонки: `id` (INTEGER PK AUTOINCREMENT), `userId` (TEXT NOT NULL UNIQUE), `userAccessHash` (TEXT NOT NULL), `userName` (TEXT, nullable), `fromChatId` (TEXT NOT NULL), `triggerMessage` (TEXT NOT NULL), `messages` (TEXT NOT NULL DEFAULT '[]'), `createdAt` (INTEGER NOT NULL), `lastActivityAt` (INTEGER NOT NULL). Индексы: `idx_dm_threads_created` на `createdAt DESC`, `idx_dm_threads_activity` на `lastActivityAt DESC`.

#### Scenario: Table auto-creates on first use
- **WHEN** любой `dm_threads_*` инструмент вызывается на чистой БД
- **THEN** таблица `dm_threads` создаётся автоматически с полной схемой и индексами

### Requirement: dm_threads_create creates a new thread
Инструмент `dm_threads_create(userId, userAccessHash, userName, fromChatId, triggerMessage, firstMessage)` SHALL создавать запись в `dm_threads`. Поле `messages` SHALL содержать JSON-массив с одним элементом `{role: "agent", msgId, text, sentAt}` из `firstMessage`. Поля `createdAt` и `lastActivityAt` SHALL быть установлены в текущий Unix timestamp.

#### Scenario: Successful thread creation
- **WHEN** `dm_threads_create` вызывается с валидными параметрами и userId не существует в таблице
- **THEN** запись создаётся, `messages` содержит `[{role: "agent", msgId: <id>, text: <text>, sentAt: <timestamp>}]`, возвращается `{ ok: true, threadId: <id> }`

#### Scenario: Duplicate userId rejected
- **WHEN** `dm_threads_create` вызывается для userId, который уже существует в таблице
- **THEN** возвращается ошибка `{ error: "thread_exists" }` (UNIQUE constraint на `userId`)

### Requirement: dm_threads_get_by_users finds threads and updates peer data
Инструмент `dm_threads_get_by_users(users: [{userId, accessHash, userName}])` SHALL находить треды по списку `userId` и обновлять `userAccessHash`/`userName` из переданных актуальных peer-данных. Обновление и выборка SHALL выполняться в одной транзакции. Возвращает объект `{ threads: [...], notFound: [userId, ...] }`.

#### Scenario: Matching threads found with peer update
- **WHEN** `dm_threads_get_by_users` вызывается со списком userId, из которых 2 имеют треды в БД
- **THEN** `userAccessHash` и `userName` обновляются до актуальных значений, возвращаются 2 полных записи тредов в `threads`, остальные userId — в `notFound`

#### Scenario: No matching threads
- **WHEN** `dm_threads_get_by_users` вызывается со списком userId, ни один из которых не имеет треда
- **THEN** `threads` пуст, все userId возвращаются в `notFound`

#### Scenario: userName updated from null to actual
- **WHEN** в треде `userName` был `null`, а в peer-данных пришёл актуальный `userName`
- **THEN** поле `userName` обновляется до актуального значения

### Requirement: dm_threads_update_msgs appends messages and updates activity
Инструмент `dm_threads_update_msgs(userId, newMessages: [{role, msgId, text, sentAt}])` SHALL дописать новые сообщения в конец JSON-массива `messages` и обновить `lastActivityAt` до `sentAt` последнего сообщения. При превышении 50 записей в `messages` SHALL удалять самые старые сообщения (sliding window).

#### Scenario: Messages appended successfully
- **WHEN** тред содержит 3 сообщения и `dm_threads_update_msgs` вызывается с 2 новыми
- **THEN** `messages` содержит 5 записей, `lastActivityAt` обновлён до `sentAt` последнего нового сообщения

#### Scenario: Sliding window trims old messages
- **WHEN** тред содержит 49 сообщений и `dm_threads_update_msgs` вызывается с 3 новыми
- **THEN** `messages` содержит 50 записей (2 самых старых удалены), в логах фиксируется предупреждение

#### Scenario: Thread not found
- **WHEN** `dm_threads_update_msgs` вызывается для несуществующего userId
- **THEN** возвращается ошибка `{ error: "thread_not_found" }`

### Requirement: dm_threads_count_today counts threads created today
Инструмент `dm_threads_count_today()` SHALL возвращать количество записей с `createdAt >= полночь UTC текущего дня`.

#### Scenario: Count reflects today's threads
- **WHEN** сегодня были созданы N тредов (N записей с `createdAt` после полуночи UTC)
- **THEN** `dm_threads_count_today` возвращает `{ count: N }`

#### Scenario: No threads today
- **WHEN** сегодня тредов не создавалось
- **THEN** `dm_threads_count_today` возвращает `{ count: 0 }`

### Requirement: dm_threads_exists checks thread existence with cooldown
Инструмент `dm_threads_exists(userId)` SHALL проверять наличие треда для userId и вычислять количество дней с `lastActivityAt`. Cooldown period: 14 дней.

#### Scenario: No thread exists
- **WHEN** для userId нет записи в `dm_threads`
- **THEN** возвращается `{ exists: false }`

#### Scenario: Thread exists, cooldown active
- **WHEN** для userId есть запись и `(now - lastActivityAt) < 14 дней`
- **THEN** возвращается `{ exists: true, cooldownActive: true, days: <кол-во дней с lastActivityAt> }`

#### Scenario: Thread exists, cooldown expired
- **WHEN** для userId есть запись и `(now - lastActivityAt) >= 14 дней`
- **THEN** возвращается `{ exists: true, cooldownActive: false, days: <кол-во дней с lastActivityAt> }`

### Requirement: dm_threads_delete removes thread by userId
Инструмент `dm_threads_delete(userId)` SHALL удалять запись из `dm_threads` по userId.

#### Scenario: Thread deleted successfully
- **WHEN** `dm_threads_delete` вызывается для существующего userId
- **THEN** запись удаляется, возвращается `{ ok: true }`

#### Scenario: Thread not found — no-op
- **WHEN** `dm_threads_delete` вызывается для несуществующего userId
- **THEN** возвращается `{ ok: true }` (идемпотентная операция)
