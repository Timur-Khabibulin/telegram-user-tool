## 1. Таблица и модуль runs (core/db/runs.ts)

- [x] 1.1 Создать `core/db/runs.ts`; схема `runs` (`id` PK autoincrement, `agentId`, `type`, `startedAt`, `durationMs`, `status`, `error` NULL, `llmCalls`, `createdAt`) + индекс `idx_runs_started(startedAt)`; `ensureRunsSchema(agentId)` идемпотентно (в per-agent `tasks.db` через `tasksDbPath`)
- [x] 1.2 Реализовать `insertRun(agentId, { type, startedAt, durationMs, status, error, llmCalls })`
- [x] 1.3 Реализовать `getRunsBetween(agentId, startSec, endSec)` — записи с `startedAt` в `[startSec, endSec)`, readonly-коннект; перед чтением `ensureRunsSchema` (агент мог ещё не писать)

## 2. Запись прогона в диспетчере (scripts/dispatcher.ts)

- [x] 2.1 Помощник `extractError(details)` — первое непустое из `error`/`reason`/`step`, иначе `JSON.stringify(details)`, обрезка ~500 симв.; при success → `null`
- [x] 2.2 После вычисления `durationMs`/`llmCalls` вызвать `insertRun` с `startedAt=Math.floor(t0/1000)`, `status=status.status`, `error=extractError`; обернуть в try/catch (сбой записи не валит прогон, `log.error`)
- [x] 2.3 Эмитить строку статуса в journald: `log.info('[run] agent=<id> type=<t> status=<s> durationMs=<d> llmCalls=<n>')`
- [x] 2.4 `ensureRunsSchema(agentId)` на старте диспетчера (рядом с `ensureTasksSchema`, шаг 0)

## 3. Перечисление агентов (core/config.ts)

- [x] 3.1 `listAgentIds()` — глоб `~/.openclaw/workspace-*`, извлечь `<agentId>` из имени каталога, вернуть список

## 4. Чистая логика сводки (core/runs-summary.ts)

- [x] 4.1 Хелперы окна UTC+5: начало/конец текущих и завершившихся суток UTC+5 в unix-сек (смещение +5ч)
- [x] 4.2 `buildDailySummary({ startSec, endSec, label })` — по `listAgentIds()` собрать `getRunsBetween` каждого агента; агрегировать `perAgent[agentId].perSkill[type] = { runs, success, error, llmCalls, durationMs }` + общий итог
- [x] 4.3 Рендер `text` — человекочитаемый русский отчёт: шапка (label, общий итог) + список ошибок (агент · скилл · текст — count); НЕ перечислять агентов по скиллам; случаи «нет прогонов» / «ошибок нет» — явные сообщения
- [x] 4.4 Вернуть `{ summary, text }`

## 5. Standalone-скрипт + systemd (scripts/daily-summary.ts, deploy/)

- [x] 5.1 `src/scripts/daily-summary.ts` — разбор `--admin <agentId>`; окно = завершившийся день UTC+5
- [x] 5.2 `buildDailySummary` → `TelegramService.loadAccount(adminAgentId)` → `sendSavedMessage(text)` → `disconnect`; ошибки логировать, ненулевой код при фатале
- [x] 5.3 `deploy/systemd/tg-daily-summary.service` — `Type=oneshot`, `ExecStart=... daily-summary.ts --admin <agentId>`, `Slice=tg-agents.slice`, `EnvironmentFile=-...`
- [x] 5.4 `deploy/systemd/tg-daily-summary.timer` — `OnCalendar=*-*-* 19:00:00 UTC` (00:00 UTC+5), `Persistent=true`
- [x] 5.5 Дополнить `deploy/README.md`: установка юнитов, подстановка `--admin <agentId>`, `enable --now tg-daily-summary.timer`

## 6. OpenClaw-пульт (index.ts, skills/daily-summary/SKILL.md)

- [x] 6.1 Инструмент `tg_daily_summary` в `index.ts` — окно = текущий день UTC+5 до `now`; `buildDailySummary`; вернуть `{ content:[{type:"text", text}] }`
- [x] 6.2 `skills/daily-summary/SKILL.md` — естественно-языковой пульт: когда вызывать `tg_daily_summary` и как вернуть текст в чат

## 7. Проверка

- [x] 7.1 `openspec validate run-status-tracking` — без ошибок
- [x] 7.2 На VPS после нескольких прогонов: в `runs` появляются записи; `journalctl -g '\[run\]'` показывает строки статуса
- [x] 7.3 Вызвать пульт `tg_daily_summary` и/или дождаться таймера — сверить сводку в Saved Messages админ-аккаунта
