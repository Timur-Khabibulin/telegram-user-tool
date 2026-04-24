---
name: join-queue-setup
description: "One-time setup skill: adds Telegram channel links to the join queue and creates a cron job (if not already running) that processes them in batches. Use when the user provides a list of channels to join automatically."
---

# Join Queue Setup

## Алгоритм выполнения

### Шаг 1 — Определить agentId

`agentId` находится в разделе **Runtime** системного промпта (поле `agentId`). Использовать это значение во всех последующих вызовах инструментов.

---

### Шаг 2 — Добавить ссылки в очередь

```
tg_join_queue_add(
  agentId: <agentId>,
  links:   <список ссылок t.me/username>
)
```

Дубли игнорируются автоматически. Запомнить `added` и `skipped` из ответа.

---

### Шаг 3 — Проверить, работает ли уже крон-задача

```
CronList()
```

Найти задачу с именем `tg-join-queue-<agentId>` в результате.

- **Задача найдена** → перейти к шагу 5.
- **Задача не найдена** → перейти к шагу 4.

---

### Шаг 4 — Создать крон-задачу

```
CronCreate(
  name:     "tg-join-queue-<agentId>",
  schedule: "0 */3 * * *",
  prompt:   "Выполни скилл join-queue-run. agentId=<agentId>",
  options:  "--enabled true --session isolated --no-deliver --tz Asia/Yekaterinburg"
)
```

---

### Шаг 5 — Вывести итог

Сообщить пользователю:
- Сколько ссылок добавлено / пропущено как дубли
- Была ли создана новая крон-задача или использована существующая
- Ориентировочное время завершения: `(added / 30) * 3 часа`
