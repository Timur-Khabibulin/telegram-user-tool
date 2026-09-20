---
name: account-warmup-cron-setup
description: "DEPRECATED — выведен из эксплуатации. Creates a cron job for Telegram account warming every 5 hours for a given agent. Use when the user wants to set up a scheduled warmup task for a specific agent."
---

# Account Warmup Cron Setup

> **DEPRECATED.** Скилл выведен из эксплуатации, использовать не нужно.

## Шаг 1 — Определить agentId

`agentId` находится в разделе **Runtime** системного промпта (поле `agentId`). Использовать это значение во всех последующих вызовах.

---

## Шаг 2 — Проверить, не существует ли задача

```bash
openclaw cron list --agent <agentId>
```

Если в списке уже есть задача с именем `account-warmup-<agentId>` — **сообщить об этом пользователю и завершить** без создания дубликата.

---

## Шаг 3 — Создать cron-задачу

```bash
openclaw cron add \
  --name "account-warmup-<agentId>" \
  --cron "0 */5 * * *" \
  --session isolated \
  --enabled true \
  --agent <agentId> \
  --message "Запусти скилл account-warmup. Это плановый прогрев аккаунта."
```

Расписание `0 */5 * * *` — каждые 5 часов

---

## Итог

Сообщить пользователю результат:

```
Cron-задача создана.
- Имя: account-warmup-<agentId>
- Агент: <agentId>
- Расписание: каждые 5 часов
- Job ID: <job_id>
```
