## Why

Сейчас исход прогона скилла (успех/ошибка) существует **только в отчёте в Telegram Saved Messages** конкретного агента. По SSH/программно полной картины нет: `tasks.db` хранит лишь `lastRun`/`nextRun`/`enabled` без статуса; journald ловит лишь исключения и `fatal`, а обработанную ошибку скилла (`status: "error"` без throw) не видит вовсе. Поэтому невозможно ответить на простой вопрос «как отработали все агенты за день» без ручного просмотра десятков Saved Messages. Нужна структурированная запись каждого прогона и агрегированная дневная сводка по всем агентам.

## What Changes

- **Новая таблица `runs`** в per-agent `tasks.db` — по строке на каждый прогон скилла: `agentId`, `type`, `startedAt`, `durationMs`, `status`, `error`, `llmCalls`, `createdAt`.
- **Новый модуль `core/db/runs.ts`** — `ensureRunsSchema`, `insertRun`, `getRunsBetween(agentId, startSec, endSec)`.
- **Диспетчер пишет `insertRun`** после каждого скилла, переиспользуя уже вычисляемые `durationMs`/`llmCalls`/`status`; текст ошибки извлекается из `status.details` (`error`/`reason`/`step`). Дополнительно эмитит одну строку статуса в journald (для стрима `journalctl -g`).
- **Чистая логика сводки `core/runs-summary.ts`** — `buildDailySummary(window)` агрегирует записи `runs` всех агентов за окно (по агенту и типу скилла: прогонов/успехов/ошибок, суммарно LLM-запросов и длительности; общий итог) и возвращает `{ структура, текст }`.
- **Перечисление агентов** — `core/config.ts:listAgentIds()` глобит `~/.openclaw/workspace-*` (граница дня — UTC+5).
- **Standalone-скрипт `src/scripts/daily-summary.ts --admin <agentId>`** — считает окно завершившегося дня UTC+5, строит сводку, грузит админ-аккаунт и шлёт в его Saved Messages. Новые systemd-юниты `tg-daily-summary.service` (oneshot) + `tg-daily-summary.timer` (`OnCalendar` раз в день, конец дня UTC+5 = 19:00 UTC).
- **OpenClaw-пульт** — инструмент `tg_daily_summary` (в `index.ts`) + скилл `skills/daily-summary/SKILL.md`: по запросу строит сводку за текущий день UTC+5 (до момента вызова) и возвращает текст в чат.

## Capabilities

### New Capabilities
- `run-log`: Таблица `runs` и модуль `core/db/runs.ts` — структурированная запись каждого прогона скилла (agentId, тип, время, длительность, статус, ошибка, LLM-запросы); диспетчер пишет запись и строку статуса в journald после каждого скилла.
- `daily-summary`: Агрегированная дневная сводка по всем агентам (граница дня UTC+5) — чистая логика `core/runs-summary.ts`, standalone-скрипт с systemd-таймером (доставка в Saved Messages админ-аккаунта) и OpenClaw-пульт `tg_daily_summary` для запроса по требованию.

## Impact

- `src/core/db/runs.ts` — новый модуль (`runs`-таблица в per-agent `tasks.db`).
- `src/core/config.ts` — `listAgentIds()` (глоб `workspace-*`).
- `src/core/runs-summary.ts` — новый: `buildDailySummary`.
- `src/scripts/dispatcher.ts` — `insertRun` + строка статуса в journald после каждого скилла.
- `src/scripts/daily-summary.ts` — новый standalone-скрипт.
- `src/index.ts` — новый инструмент `tg_daily_summary`.
- `skills/daily-summary/SKILL.md` — новый OpenClaw-скилл-пульт.
- `deploy/systemd/tg-daily-summary.service` / `.timer` — новые юниты; `deploy/README.md` — установка и `--admin <agentId>`.
- **Зависимость:** опирается на `durationMs`/`llmCalls`, введённые в неархивированном change `improve-skill-reports`.
