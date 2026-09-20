---
name: dm-replies-cron-setup
description: "DEPRECATED — выведен из эксплуатации. Creates a cron job for periodic DM reply processing for a given agent. Use when the user wants to set up a scheduled DM replies task (Cron 3) for a specific agent."
---

# DM Replies Cron Setup

> **DEPRECATED.** Скилл выведен из эксплуатации, использовать не нужно.

## Шаг 1 — Определить agentId

`agentId` находится в разделе **Runtime** системного промпта (поле `agentId`). Использовать это значение во всех последующих вызовах инструментов.

---

## Шаг 2 — Создать cron-задачу

```bash
openclaw cron add \
  --name "dm-replies-cron-<agentId>" \
  --cron "*/30 * * * *" \
  --tz "Asia/Yekaterinburg" \
  --session isolated \
  --enabled true \
  --agent <agentId> \
  --message "Запусти скилл dm-replies. Это задача обработки входящих DM-ответов."
```

Расписание `*/30 * * * *` запускает задачу каждые 30 минут.

---

## Итог

Сообщить пользователю job id и подтверждение успешного создания:

```
Cron-задача создана.
- Имя: dm-replies-cron-<agentId>
- Агент: <agentId>
- Расписание: каждые 30 минут
- Job ID: <job_id>
```
