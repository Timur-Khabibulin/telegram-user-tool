---
name: dm-send-cron-setup
description: "Creates a cron job for daily DM outreach sending for a given agent. Use when the user wants to set up a scheduled DM sending task (Cron 2) for a specific agent."
---

# DM Send Cron Setup

## Шаг 1 — Определить agentId

`agentId` находится в разделе **Runtime** системного промпта (поле `agentId`). Использовать это значение во всех последующих вызовах инструментов.

---

## Шаг 2 — Создать cron-задачу

```bash
openclaw cron add \
  --name "dm-send-cron-<agentId>" \
  --cron "0 14 * * *" \
  --tz "Asia/Yekaterinburg" \
  --session isolated \
  --enabled true \
  --agent <agentId> \
  --message "Запусти скилл dm-send. Это ежедневная задача отправки DM кандидатам."
```

Расписание `0 14 * * *` соответствует 14:00 UTC+5 (Екатеринбург / Астана).

---

## Итог

Сообщить пользователю job id и подтверждение успешного создания:

```
Cron-задача создана.
- Имя: dm-send-cron-<agentId>
- Агент: <agentId>
- Расписание: ежедневно в 14:00 UTC+5 (09:00 UTC)
- Job ID: <job_id>
```
