---
name: project-error-normalization
description: Инициатива по сквозной нормализации/локализации ошибок в отчётах диспетчера OpenClaw-агента
metadata:
  type: project
---

Идёт работа над слоем нормализации ошибок: отчёты диспетчера в Telegram при сбоях показывают только `err.message` (для LLM это бесполезное "Bad Request"), нужно локализовать (скилл→шаг→подсистема) и детерминировать причину.

**Why:** оператор не может диагностировать сбой по отчёту, лезет в логи сервера, растёт MTTR. Реальная причина LLM-ошибки лежит в APICallError `.statusCode`/`.responseBody`, а не в `.message`.

**How to apply:**
- Три канала вывода с разными лимитами: Telegram-отчёт (~280 симв/строка, `REPORT_TEXT_LIMIT`), `runs.error` (≤500, `RUN_ERROR_LIMIT`), stdout/journald (полный).
- Два пути возникновения ошибки покрыть оба: проброс наверх в `dispatcher.ts` catch (~:204) И ручная упаковка `{step,reason,error}` в `details` внутри скиллов.
- Источники ошибок: LLM (APICallError/ZodError), Telegram/GramJS (FloodWaitError/RPCError), SQLite (`err.code` SQLITE_*), zod, unknown.
- Не трогать success-путь и доменные стоп-причины (напр. `{error:"peer_flood"}` при status=success — это не сбой).
- `completeObject` (`src/llm/client.ts`) сейчас заворачивает причину в голый `new Error(...)`, теряя APICallError — нужно прокидывать через `Error.cause`.
- Архитектор предложил `core/errors/` + type-guard классификацию + возможный `serialize-error`.

Статус на 2026-06-04: я подготовил аналитический документ (User Stories, AC, NFR, ТЗ) и список открытых вопросов Q1–Q8 заказчику. Жду ответов перед уточнением AC / оформлением OpenSpec-change.
