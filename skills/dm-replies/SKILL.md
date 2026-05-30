---
name: dm-replies
description: "Process incoming DM replies using push-model: detect unread DMs via telegram_get_dm_dialogs, match with dm_threads, continue dialogue with full context. Use when the agent needs to check for and respond to replies in active DM conversations. Triggers: 'check dm replies', 'process dm replies', 'reply to dms', 'dm dialogue', 'run dm-replies'."
---

# DM Replies — Обработка входящих ответов на DM

## Цель

Проверять входящие ответы в DM-диалогах через push-модель: запрашивать у Telegram список личных чатов с непрочитанными сообщениями, матчить с `dm_threads`, и продолжать диалог с полным контекстом переписки. Работает только в дневные часы UTC+5.

---

## Ограничения

- Работает только в период **08:00–01:00 UTC+5** (Екатеринбург / Астана).
- Нет искусственного лимита ответов — диалог продолжается пока пользователь пишет.
- Cooldown тредов: 14 дней по `lastActivityAt` (управляется на стороне `dm-send`).
- Негативный тон (определяется LLM) → агент не отвечает, mark_as_read.

---

## Основной алгоритм

Выполнять **строго по шагам**:

### Шаг 0 — Проверить время (UTC+5)

Вычислить текущее время в UTC+5 (прибавить 5 часов к UTC).

- Если время **вне диапазона 08:00–01:00** следующих суток (т.е. 01:00–08:00 UTC+5) — **завершить выполнение**.

---

### Шаг 1 — Загрузить аккаунт

```
tg_load_account(agentId: <agentId>)
```

Если ошибка — завершить выполнение.

---

### Шаг 2 — Получить DM-чаты с непрочитанными сообщениями

```
telegram_get_dm_dialogs()
```

Результат: `{ dms: [{ userId, accessHash, userName, firstName, unreadCount, readInboxMaxId }] }`

Этот инструмент также заполняет `peerCache` записью `InputPeerUser` для каждого возвращённого пользователя.

Если `dms` пуст — перейти к **Шагу 5** (уведомление), затем завершить.

---

### Шаг 3 — Найти треды для пользователей с непрочитанными

```
dm_threads_get_by_users(
  agentId: <agentId>,
  users: [
    { userId: "<userId>", accessHash: "<accessHash>", userName: "<userName>" },
    ...
  ]
)
```

Передать данные из каждого элемента `dms` из Шага 2.

Результат: `{ threads: [...], notFound: [userId, ...] }`

- `notFound` — игнорировать. Это DM от пользователей, для которых нет треда в `dm_threads` (т.е. не наш пользователь, DM не через `dm-send`). Тред создаётся только через скилл `dm-send`.

- Если `threads` пуст — перейти к **Шагу 5** (уведомление), затем завершить.

---

### Шаг 4 — Обработать каждый тред

Для каждого треда из `threads` (Шаг 3):

#### 4.1 — Получить новые сообщения

Определить `lastMsgId` — `msgId` последнего сообщения из `thread.messages` (JSON массив). Это будет `minId` для запроса.

```
telegram_get_messages(
  chatId: <thread.userId>,
  minId:  <lastMsgId>
)
```

Результат: список новых сообщений от пользователя (после последнего известного сообщения).

Если новых сообщений нет — перейти к следующему треду.

#### 4.2 — Sentiment analysis (LLM)

Оценить тональность **последнего** сообщения пользователя:

```
Оцени тональность последнего сообщения пользователя.
Верни JSON: { "sentiment": "positive" | "negative" }

Позитивное/нейтральное — интерес, вопрос, согласие, продолжение разговора.
Негативное — агрессия, просьба не писать, оскорбления, "спам", "отпишись".

Сообщение: "<текст последнего сообщения пользователя>"
```

- Если `sentiment = "negative"`:
  ```
  telegram_mark_as_read(chatId: <thread.userId>)
  ```
  Перейти к следующему треду. Тред **не удаляется** — cooldown продолжает работать.

- Если `sentiment = "positive"` → продолжить.

#### 4.3 — Сгенерировать ответ (LLM)

Передать LLM полный контекст переписки:

```
Напиши ответ на сообщение пользователя в личной переписке Telegram.

Контекст — пользователь написал в групповом чате:
"<thread.triggerMessage>"

История переписки (от старых к новым):
<thread.messages — до 50 сообщений в формате "role: text">

Новые сообщения пользователя:
<список новых сообщений из шага 4.1>

Требования:
- Продолжи диалог естественно, учитывая всю историю
- Стиль возьми из своей личности
- Задай уточняющий вопрос или опиши свой опыт
- До 3 предложений, на языке пользователя
```

#### 4.4 — Отправить ответ

```
telegram_send_dm(
  userId: <thread.userId>,
  text:   <ответ из 4.3>
)
```

Обработка ошибок:

- `{ ok: true, messageId }` → продолжить к 4.5
- `{ error: 'privacy_blocked' }` → `telegram_mark_as_read(chatId: <thread.userId>)`, перейти к следующему треду (тред сохраняется)
- `{ error: 'flood_wait' }` → **немедленно прервать прогон** (перейти к Шагу 5)
- `{ error: 'peer_id_invalid' }` → `telegram_mark_as_read(chatId: <thread.userId>)`, перейти к следующему треду. `accessHash` обновится на следующем прогоне через `dm_threads_get_by_users`.
- Любая другая ошибка → `telegram_mark_as_read(chatId: <thread.userId>)`, перейти к следующему треду

#### 4.5 — Обновить тред

Записать **все** новые сообщения (и от пользователя, и агента) в тред:

```
dm_threads_update_msgs(
  agentId: <agentId>,
  userId:  <thread.userId>,
  newMessages: [
    { role: "user",  msgId: <msgId1>, text: "<текст>", sentAt: <timestamp> },
    { role: "user",  msgId: <msgId2>, text: "<текст>", sentAt: <timestamp> },
    ...все новые user-сообщения из шага 4.1...,
    { role: "agent", msgId: <messageId из 4.4>, text: "<ответ из 4.3>", sentAt: <текущий unix timestamp> }
  ]
)
```

Порядок в массиве: сначала все user-сообщения (в хронологическом порядке), затем agent-сообщение.

#### 4.6 — Пометить прочитанным (последний шаг)

```
telegram_mark_as_read(chatId: <thread.userId>)
```

Этот шаг **всегда последний** в обработке каждого пользователя. Гарантирует, что сообщение не будет потеряно при сбое на предыдущих шагах.

---

### Шаг 5 — Итоговое уведомление

Отправить сообщение в Saved Messages с итогами прогона:
- сколько DM-чатов с непрочитанными найдено
- сколько тредов совпало
- сколько ответов отправлено
- были ли ошибки

---

## Инструменты

| Инструмент | Шаг | Файл |
|------------|-----|------|
| `tg_load_account` | 1 | index.ts |
| `telegram_get_dm_dialogs` | 2 | index.ts |
| `dm_threads_get_by_users` | 3 | dm-threads-db.ts |
| `telegram_get_messages` | 4.1 | index.ts |
| `telegram_send_dm` | 4.4 | index.ts |
| `dm_threads_update_msgs` | 4.5 | dm-threads-db.ts |
| `telegram_mark_as_read` | 4.2, 4.4, 4.6 | index.ts |
