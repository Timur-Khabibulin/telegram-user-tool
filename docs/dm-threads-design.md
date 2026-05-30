# Design Doc: DM Threads — Контекстные диалоги в личных сообщениях

**Дата:** 2026-05-25
**Автор:** Timur / Claude
**Статус:** Draft

---

## 1. Контекст и проблема

Агент умеет отправлять DM пользователям из групп (`dm-send`) и отвечать на их реплики (`dm-replies`).
Но текущая реализация имеет три фундаментальных ограничения:

### 1.1 Потеря контекста переписки

`dm_history` хранит только `triggerText` (сообщение из группы) и `dmText` (первый DM агента).
Промежуточные сообщения — ответ пользователя, ответ агента — нигде не сохраняются.

```
dm_history хранит:
┌──────────────────────────────────────────────────────┐
│  triggerText    "Ищу подрядчика на бэкенд"           │  ← из группы
│  dmText         "Привет! Видел твоё сообщение..."    │  ← первый DM
│  replyCount     1                                    │
│  lastAgentMsgAt 1716641800                           │
└──────────────────────────────────────────────────────┘

Что происходит на втором ответе пользователя:
┌──────────────────────────────────────────────────────────────┐
│  LLM получает контекст:                                      │
│                                                              │
│  - Ты написал первым: "Привет! Видел..."         ← есть     │
│  - Пользователь ответил: ???                     ← ПОТЕРЯНО │
│  - Ты ответил: ???                               ← ПОТЕРЯНО │
│  - Пользователь написал снова: "Да, расскажи"    ← Telegram │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 Искусственный лимит в 2 ответа

Диалог принудительно завершается после `replyCount = 2 → status = done`.
Агент не может вести полноценную переписку, даже если пользователь заинтересован.

### 1.3 Poll вместо Push

`dm-replies` на каждом прогоне перебирает **все** активные записи в `dm_history`
и для каждой вызывает `telegram_get_dm_replies`.
При росте базы это O(N) API-вызовов к Telegram на каждый прогон.

```
Текущий подход (poll):                   Целевой подход (push):

┌──────────────────────┐                 ┌──────────────────────┐
│  dm_history_get_     │                 │  telegram_get_dm_    │
│  active              │                 │  dialogs()           │
│  → 150 записей       │                 │  → 3 чата с unread   │
└──────────┬───────────┘                 └──────────┬───────────┘
           │                                        │
           ▼                                        ▼
┌──────────────────────┐                 ┌──────────────────────┐
│  telegram_get_dm_    │                 │  dm_threads WHERE    │
│  replies(150 entries)│                 │  userId IN (3 ids)   │
│  → 150 API вызовов   │                 │  → 2 совпадения      │
└──────────────────────┘                 └──────────────────────┘
                                         Только 2 API вызова
```

---

## 2. Решение

### 2.1 Новая таблица `dm_threads`

Заменяет `dm_history` как трекер диалога. Хранит полную цепочку сообщений в JSON.

### 2.2 Push-модель проверки ответов

Вместо опроса каждого треда — запрашиваем у Telegram список личных чатов с непрочитанными,
матчим с `dm_threads`.

### 2.3 Без искусственных лимитов

Нет `replyCount`, нет `status = done`. Тред живёт пока есть активность.
Cooldown 14 дней по `lastActivityAt` — после этого тред удаляется и пользователю можно написать снова.

---

## 3. Схема данных

### 3.1 Таблица `dm_threads`

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                 dm_threads                                  │
├─────────────────┬──────────┬────────────────────────────────────────────────┤
│  Поле           │ Тип      │ Описание                                      │
├─────────────────┼──────────┼────────────────────────────────────────────────┤
│  id             │ INTEGER  │ PK, autoincrement                             │
│  userId         │ TEXT     │ Telegram user ID (он же DM chat ID)           │
│  userAccessHash │ TEXT     │ Access hash для InputPeerUser                 │
│  userName       │ TEXT     │ Username (@handle), nullable                  │
│  fromChatId     │ TEXT     │ ID группы, где найден пользователь            │
│  triggerMessage │ TEXT     │ Сообщение пользователя из группы              │
│  messages       │ TEXT     │ JSON — полная цепочка переписки               │
│  createdAt      │ INTEGER  │ Unix timestamp создания треда                 │
│  lastActivityAt │ INTEGER  │ Unix timestamp последнего сообщения (любого)  │
├─────────────────┴──────────┴────────────────────────────────────────────────┤
│  UNIQUE(userId)                                                            │
│  INDEX idx_dm_threads_created ON (createdAt DESC)                          │
│  INDEX idx_dm_threads_activity ON (lastActivityAt DESC)                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

```sql
CREATE TABLE IF NOT EXISTS dm_threads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    userId          TEXT    NOT NULL UNIQUE,
    userAccessHash  TEXT    NOT NULL,
    userName        TEXT,
    fromChatId      TEXT    NOT NULL,
    triggerMessage  TEXT    NOT NULL,
    messages        TEXT    NOT NULL DEFAULT '[]',
    createdAt       INTEGER NOT NULL,
    lastActivityAt  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_threads_created  ON dm_threads (createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_dm_threads_activity ON dm_threads (lastActivityAt DESC);
```

### 3.2 Структура `messages` JSON

```json
[
  {
    "role": "agent",
    "msgId": 55201,
    "text": "Привет! Видел твоё сообщение про подрядчика...",
    "sentAt": 1716640000
  },
  {
    "role": "user",
    "msgId": 55210,
    "text": "Да, ищу кого-то на Node.js",
    "sentAt": 1716641800
  },
  {
    "role": "agent",
    "msgId": 55215,
    "text": "У меня как раз есть опыт с Node. Расскажу подробнее...",
    "sentAt": 1716642000
  }
]
```

### 3.2.1 Лимит messages

Максимальная длина массива `messages`: **50 записей**. При превышении — удаляются самые старые
сообщения (sliding window). В логах фиксируется предупреждение.

`triggerMessage` хранится в отдельном поле таблицы и не теряется при обрезке.

Обоснование: при cooldown 14 дней и типичной частоте обмена 2-3 раза в день,
реалистичный максимум — 20-30 сообщений. Лимит 50 — запас x2.

### 3.3 Связь userId и DM chatId

В Telegram для личных чатов `chatId === userId`.
Отдельного поля `dmChatId` не требуется — матч с `telegram_get_dm_dialogs` делается по `userId`.

### 3.4 Удаляемая таблица: `dm_history`

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            dm_history (УДАЛЯЕТСЯ)                           │
├─────────────────┬───────────────────────────────────────────────────────────┤
│  Поле           │ Куда переносится                                         │
├─────────────────┼───────────────────────────────────────────────────────────┤
│  userId         │ → dm_threads.userId                                      │
│  userAccessHash │ → dm_threads.userAccessHash                              │
│  username       │ → dm_threads.userName                                    │
│  triggerText    │ → dm_threads.triggerMessage                               │
│  dmText         │ → dm_threads.messages[0].text                            │
│  sentAt         │ → dm_threads.createdAt                                   │
│  lastAgentMsgAt │ → dm_threads.lastActivityAt                              │
│  replyCount     │ → вычисляется из messages (count role=agent)              │
│  status         │ → УДАЛЯЕТСЯ (не нужен)                                   │
└─────────────────┴───────────────────────────────────────────────────────────┘
```

### 3.5 Стратегия перехода

Миграция данных из `dm_history` в `dm_threads` **не выполняется** — начинаем с чистого листа.

- Таблица `dm_threads` создаётся пустой при первом вызове любого `dm_threads_*` инструмента.
- Таблица `dm_history` остаётся в БД, но не используется новыми скиллами.
- Старые инструменты (`dm_history_*`) удаляются из кода одновременно с деплоем новых.
- Существующие диалоги из `dm_history` считаются завершёнными.

---

## 4. Инструменты

### 4.1 Новый Telegram-инструмент

#### `telegram_get_dm_dialogs`

Возвращает список личных чатов с непрочитанными сообщениями.
Аналог `telegram_get_dialogs`, но для DM.

```
telegram_get_dm_dialogs()

→ {
    dms: [
      {
        userId:         "123456789",
        accessHash:     "8837492710283",
        userName:       "ivan_dev",
        firstName:      "Ivan",
        unreadCount:    3,
        readInboxMaxId: 5520
      }
    ]
  }
```

Также заполняет `peerCache` для каждого возвращённого пользователя (`InputPeerUser`).

### 4.2 Новые DB-инструменты

```
┌──────────────────────────┬─────────────────────────────────────────────────────────┐
│  Инструмент              │ Назначение                                              │
├──────────────────────────┼─────────────────────────────────────────────────────────┤
│  dm_threads_create       │ Создать тред при первой отправке DM                     │
│  dm_threads_get_by_users │ Найти треды по списку userId, обновить accessHash/      │
│                          │ userName из свежих peer-данных                          │
│  dm_threads_update_msgs  │ Дописать сообщения в messages JSON,                     │
│                          │ обновить lastActivityAt                                │
│  dm_threads_count_today  │ Сколько тредов создано сегодня (лимит первых DM)        │
│  dm_threads_exists       │ Есть ли активный тред для userId (cooldown 14 дней)     │
│  dm_threads_delete       │ Удалить тред по userId (для перезапуска после cooldown) │
└──────────────────────────┴─────────────────────────────────────────────────────────┘
```

#### `dm_threads_exists` — детали

Проверяет существование треда с учётом cooldown 14 дней по `lastActivityAt`:

```
dm_threads_exists(userId: "123456")

→ { exists: false }                                — треда нет, можно отправить DM
→ { exists: true, cooldownActive: true, days: 3 }  — тред есть, cooldown не истёк
→ { exists: true, cooldownActive: false, days: 20 } — тред есть, cooldown истёк
```

```sql
SELECT id, lastActivityAt,
       CAST((strftime('%s','now') - lastActivityAt) / 86400 AS INTEGER) AS days
FROM dm_threads WHERE userId = @userId LIMIT 1
```

#### `dm_threads_get_by_users` — обновление peer-данных

Принимает актуальные peer-данные из `telegram_get_dm_dialogs` и обновляет `accessHash`/`userName`:

```
dm_threads_get_by_users(
  users: [
    { userId: "123", accessHash: "abc123", userName: "@ivan_dev" },
    { userId: "456", accessHash: "def456", userName: null }
  ]
)

→ {
    threads: [ { id, userId, userAccessHash, userName, fromChatId,
                 triggerMessage, messages, createdAt, lastActivityAt } ],
    notFound: ["456"]
  }
```

Внутри в одной транзакции: UPDATE accessHash/userName → SELECT треды.

### 4.3 Удаляемые инструменты

```
┌──────────────────────────┬─────────────────────────────────────────────────────────┐
│  Удаляется               │ Заменён на                                              │
├──────────────────────────┼─────────────────────────────────────────────────────────┤
│  dm_history_insert       │ dm_threads_create                                       │
│  dm_history_count_today  │ dm_threads_count_today                                  │
│  dm_history_check_       │ dm_threads_exists                                       │
│    cooldown              │                                                         │
│  dm_history_get_active   │ dm_threads_get_by_users                                 │
│  dm_history_update       │ dm_threads_update_msgs                                  │
│  telegram_get_dm_replies │ telegram_get_dm_dialogs + telegram_get_messages          │
└──────────────────────────┴─────────────────────────────────────────────────────────┘
```

### 4.4 Без изменений

`telegram_send_dm`, `telegram_get_messages`, `telegram_mark_as_read` — работают как есть.

---

## 5. Изменения в скиллах

### 5.1 dm-send — новый алгоритм

```
                    ┌─────────────────────┐
                    │   dm-send запуск    │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ dm_threads_count_   │
                    │ today() >= 15?      │
                    ├──────────┬──────────┤
                    │   Да     │   Нет    │
                    └────┬─────┴────┬─────┘
                         │          │
                    ┌────▼────┐     │
                    │  СТОП   │     │
                    └─────────┘     │
                                    ▼
                    ┌─────────────────────┐
                    │ Для каждого         │
                    │ кандидата:          │
                    │                     │
                    │ dm_threads_exists   │
                    │ (userId)            │
                    ├──────┬──────┬───────┤
                    │exists│exists│  not  │
                    │cool- │cool- │exists │
                    │down  │down  │       │
                    │active│false │       │
                    └──┬───┴──┬───┴──┬────┘
                       │      │      │
                  ┌────▼──┐   │      │
                  │ SKIP  │   │      │
                  └───────┘   │      │
                              ▼      │
                    ┌──────────────┐  │
                    │dm_threads_   │  │
                    │delete(userId)│  │
                    └──────┬───────┘  │
                           │          │
                           ▼          ▼
                    ┌─────────────────────┐
                    │ telegram_send_dm    │
                    │ → отправить DM      │
                    └──────────┬──────────┘
                               │ ok
                               ▼
                    ┌─────────────────────┐
                    │ dm_threads_create   │
                    │ → записать тред     │
                    │   с первым msg      │
                    └─────────────────────┘
```

**Ключевые отличия от текущего:**

- Лимит 15 считает только **новые треды** (createdAt сегодня), а не все отправки
- Cooldown 14 дней через `lastActivityAt`:
  - Тред активен → skip
  - Cooldown истёк → удалить старый тред, создать новый
  - Треда нет → создать
- Вместо `dm_history_insert` → `dm_threads_create`

### 5.2 dm-replies — новый алгоритм

```
┌──────────────────────────────────────────────────────────────────────┐
│                        dm-replies прогон                             │
└──────────────────────────────────────────────────────────────────────┘

  Шаг 0: Проверить время UTC+5.
          01:00–08:00 → СТОП.

  Шаг 1: tg_load_account(agentId)

  Шаг 2: telegram_get_dm_dialogs()
          → список DM-чатов с unread > 0
          → заполняет peerCache для InputPeerUser

  Шаг 3: dm_threads_get_by_users(users: [...])
          → совпадения с тредами (+ обновление accessHash/userName)
          → нет совпадений → СТОП

  Шаг 4: Для каждого совпадения:

    4.1  telegram_get_messages(chatId=userId, minId=<lastMsgId из thread.messages>)
         → новые сообщения пользователя

    4.2  SENTIMENT ANALYSIS (LLM):
         """
         Оцени тональность последнего сообщения пользователя.
         Верни JSON: { "sentiment": "positive" | "negative" }

         Позитивное/нейтральное — интерес, вопрос, согласие, продолжение разговора.
         Негативное — агрессия, просьба не писать, оскорбления, "спам", "отпишись".

         Сообщение: "<текст последнего сообщения>"
         """

         negative → telegram_mark_as_read(chatId=userId), перейти к следующему.
         positive → продолжить.

    4.3  LLM генерирует ответ с контекстом:
         - triggerMessage (сообщение из группы)
         - thread.messages (последние 50 сообщений цепочки)
         - новые user-сообщения

    4.4  telegram_send_dm(userId, text) → отправить ответ

    4.5  dm_threads_update_msgs(userId, newMessages=[...userMsgs, agentMsg])
         → обновляет messages JSON и lastActivityAt

    4.6  telegram_mark_as_read(chatId=userId)
```

**Ключевые отличия от текущего:**

- **Рабочие часы** (шаг 0): 08:00–01:00 UTC+5, как в текущей реализации
- **Push-модель**: не перебирает все треды — реагирует только на чаты с непрочитанными
- **Sentiment analysis** (шаг 4.2): при негативе — mark_as_read + пропуск (тред сохраняется, cooldown работает)
- **Нет лимита ответов** — диалог продолжается пока пользователь пишет
- **Полный контекст** переписки в каждом ответе LLM
- **mark_as_read последним** (шаг 4.6) — гарантирует, что сообщение пользователя не потеряется

---

## 6. Граничные случаи

### 6.1 Пользователь пишет первым (не из нашего DM)

```
telegram_get_dm_dialogs → userId: 999, unread: 1
dm_threads_get_by_users([999]) → пусто
→ Игнорируем. Тред создаётся только через dm-send.
```

### 6.2 Несколько сообщений от пользователя за один прогон

```
messages (до прогона):
  [agent: "Привет!"]

telegram_get_messages → 3 новых сообщения от пользователя

messages (после прогона):
  [agent: "Привет!",
   user: "Ой, привет",          ← все три добавляются
   user: "Видел твоё сообщение",
   user: "Расскажи подробнее",
   agent: "Конечно, вот..."]    ← один ответ на все
```

Агент отвечает **один раз**, учитывая все новые сообщения.

### 6.3 Протухший accessHash

Если `telegram_send_dm` вернул ошибку из-за невалидного accessHash — не удаляем тред.
На следующем прогоне `telegram_get_dm_dialogs` вернёт свежий peer для этого userId,
`dm_threads_get_by_users` обновит `userAccessHash` в треде автоматически.

### 6.4 Cooldown истёк — повторный контакт

Если `dm_threads_exists` возвращает `cooldownActive: false` (прошло >14 дней без активности):
- Старый тред удаляется через `dm_threads_delete`
- При наличии нового кандидата для этого userId — создаётся новый тред с чистым контекстом
- Новый `triggerMessage` берётся из нового сообщения в группе

### 6.5 Обработка ошибок в dm-replies

При ошибках `telegram_send_dm` на шаге 4.4:
- `privacy_blocked` → mark_as_read, перейти к следующему (тред сохраняется)
- `flood_wait` → прервать прогон
- `peer_id_invalid` → mark_as_read, перейти к следующему (accessHash обновится на следующем прогоне)