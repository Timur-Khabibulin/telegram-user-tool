---
name: dm-replies
description: "Process incoming DM replies and continue dialogue up to 2 exchanges. Use when the agent needs to check for and respond to replies in active DM conversations. Triggers: 'check dm replies', 'process dm replies', 'reply to dms', 'dm dialogue', 'run dm-replies'."
---

# DM Replies — Обработка входящих ответов на DM

## Цель

Проверять входящие ответы в активных DM-диалогах и продолжать диалог до 2 обменов (агент → пользователь → агент → пользователь → агент). Работает только в дневные часы UTC+5.

---

## Ограничения

- Работает только в период **08:00–01:00 UTC+5** (Екатеринбург / Астана).
- Диалог продолжается максимум до **2 ответов агента** (replyCount 0→1→2, затем status→done).
- Без ответа от пользователя более **48 часов** → статус переводится в `done`.
- Негативный тон (определяется LLM) → агент не отвечает, status→done.

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

### Шаг 2 — Получить активные диалоги

```
dm_history_get_active(agentId: <agentId>)
```

Результат: список записей со статусом `sent` или `in_dialogue`.

Если список пустой — завершить выполнение.

---

### Шаг 3 — Получить новые ответы пользователей

```
telegram_get_dm_replies(
  entries: [
    {
      userId:        <entry.userId>,
      userAccessHash: <entry.userAccessHash>,
      lastAgentMsgAt: <entry.lastAgentMsgAt>
    },
    ...
  ]
)
```

Результат: `{ results: [{ userId, messages: [{ id, text, date }] }] }`

---

### Шаг 4 — Обработать каждый диалог

Для каждой записи из `dm_history_get_active`, сопоставить с ответами из Шага 3:

#### 4a — Первый ответ пользователя (status = 'sent', replyCount = 0)

**Условие:** пользователь прислал хотя бы одно новое сообщение.

Проверить тональность (LLM):

```
Оцени тональность следующего сообщения: позитивная/нейтральная или негативная/агрессивная?
Верни JSON: { "sentiment": "positive" | "negative" }

Сообщение: "<текст последнего ответа пользователя>"
```

- Если `sentiment = 'negative'` → `dm_history_update(agentId, id, { status: 'done' })`, не отвечать.
- Если `sentiment = 'positive'` → сгенерировать и отправить ответ агента:

```
Напиши ответ на это сообщение в личной переписке Telegram.
Контекст — ты ранее написал этому пользователю: "<entry.dmText>"
Пользователь ответил: "<текст ответа пользователя>"

Требования:
- Продолжи диалог естественно
- Задай уточняющий вопрос или опиши свой опыт исходя из своей личности
- До 3 предложений, на языке пользователя
```

```
telegram_send_dm(
  userId:     <entry.userId>,
  accessHash: <entry.userAccessHash>,
  text:       <ответ агента>
)
```

При успехе:

```
dm_history_update(
  agentId: <agentId>,
  id:      <entry.id>,
  fields: {
    status:        'in_dialogue',
    replyCount:    1,
    lastAgentMsgAt: <текущий unix timestamp>
  }
)
```

#### 4b — Второй ответ пользователя (status = 'in_dialogue', replyCount = 1)

**Условие:** пользователь прислал хотя бы одно новое сообщение.

Проверить тональность (LLM) — аналогично 4a.

- Если `sentiment = 'negative'` → `dm_history_update(agentId, id, { status: 'done' })`, не отвечать.
- Если `sentiment = 'positive'` → сгенерировать финальный ответ:

```
Напиши финальный ответ в личной переписке Telegram.
Контекст диалога:
- Ты написал первым: "<entry.dmText>"
- Пользователь ответил (первый раз): "<первый ответ>"
- Ты ответил: "<ответ агента после 4a>"
- Пользователь ответил (второй раз): "<текст последнего ответа>"

Требования:
- Завершающий, естественный
- До 4 предложений, на языке пользователя
```

```
telegram_send_dm(
  userId:     <entry.userId>,
  accessHash: <entry.userAccessHash>,
  text:       <финальный ответ>
)
```

При успехе:

```
dm_history_update(
  agentId: <agentId>,
  id:      <entry.id>,
  fields: {
    status:        'done',
    replyCount:    2,
    lastAgentMsgAt: <текущий unix timestamp>
  }
)
```


#### 4c — Нет ответа (status = 'sent' или 'in_dialogue', нет новых сообщений)

Проверить: если `now - entry.lastAgentMsgAt > 48 * 3600`:

```
dm_history_update(
  agentId: <agentId>,
  id:      <entry.id>,
  fields: { status: 'done' }
)
```

---

## Инструменты

| Инструмент | Шаг | Файл |
|------------|-----|------|
| `tg_load_account` | 1 | index.ts |
| `dm_history_get_active` | 2 | channels-db.ts |
| `telegram_get_dm_replies` | 3 | index.ts |
| `telegram_send_dm` | 4a, 4b | index.ts |
| `dm_history_update` | 4a, 4b, 4c | channels-db.ts |
