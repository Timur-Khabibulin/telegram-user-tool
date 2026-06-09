## Context

Диспетчер (`src/scripts/dispatcher.ts`) — один процесс на агента (systemd `tg-agent@<agentId>.service`), выполняет назревшие задачи из per-agent `tasks.db` последовательно. После change `improve-skill-reports` он уже замеряет `durationMs` и `llmCalls` (срез `llm.requestCount`) вокруг `skill(ctx)` и шлёт отчёт в Saved Messages. Исход прогона нигде не сохраняется структурно: `tasks.db` без статуса, journald без обработанных ошибок. Хранение решено держать **по агентам** (отдельная БД на агента), доставку сводки — в Saved Messages выделенного админ-аккаунта, границу дня — по **UTC+5**, форму сводки — **и** скрипт по таймеру, **и** OpenClaw-пульт.

## Goals / Non-Goals

**Goals:**
- Структурная запись каждого прогона (все поля) в таблицу `runs` per-agent `tasks.db`.
- Строка статуса в journald для потокового поиска.
- Дневная сводка по всем агентам (UTC+5) единой чистой логикой, доступная двумя путями (таймер + пульт).

**Non-Goals:**
- Не менять `formatReport` / формат per-run отчёта в Saved Messages (из `improve-skill-reports`).
- Не вводить центральную БД — записи остаются по агентам.
- Не добавлять статус в таблицу `tasks` — отдельная таблица `runs`.
- Не менять логику самих скиллов.

## Decisions

### 1. Таблица `runs` в существующей per-agent `tasks.db`
Новый модуль `core/db/runs.ts`: `ensureRunsSchema(agentId)`, `insertRun(agentId, row)`, `getRunsBetween(agentId, startSec, endSec)`. Схема:
```
CREATE TABLE IF NOT EXISTS runs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId   TEXT    NOT NULL,
  type      TEXT    NOT NULL,
  startedAt INTEGER NOT NULL,   -- unix-сек, момент старта скилла
  durationMs INTEGER NOT NULL,
  status    TEXT    NOT NULL,   -- 'success' | 'error'
  error     TEXT,               -- NULL при success
  llmCalls  INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(startedAt);
```
- **Почему та же `tasks.db`, а не отдельный файл:** агент уже открывает её каждый прогон, путь даёт `tasksDbPath`; меньше сущностей. `agentId` дублируется в строках намеренно — сводка объединяет строки из разных файлов, и каждая строка самоописательна.
- **Индекс по `startedAt`** — выборка окна сводки.

### 2. Запись в диспетчере — переиспользовать уже посчитанное
В `dispatcher.main` после блока, где уже есть `durationMs` и `llmCalls`, добавляется `insertRun`. `startedAt = Math.floor(t0/1000)`. `error` извлекается из `status.details` помощником `extractError(details)`: первое непустое из `error` → `reason` → `step` → `JSON.stringify(details)` (обрезка до ~500 симв.); при `status = success` → `null`. Вызов обёрнут в try/catch (R: сбой записи не валит прогон). Рядом — `log.info` строки статуса вида `[run] agent=<id> type=<t> status=<s> durationMs=<d> llmCalls=<n>` для `journalctl -g`.
- **Альтернатива:** считать поля заново — отвергнуто, всё уже есть в области видимости.

### 3. Перечисление агентов — глоб `workspace-*`
`core/config.ts:listAgentIds()` читает `~/.openclaw`, выбирает каталоги `workspace-<id>`, возвращает список `id`. Сводка по нему открывает каждую `tasksDbPath(agentId)` в readonly и зовёт `getRunsBetween`. Несуществующая/пустая `runs` у агента — пустой вклад, не ошибка (`ensureRunsSchema` перед чтением или CREATE IF NOT EXISTS).
- **Почему глоб, а не реестр:** workspace-каталоги — фактический источник истины об агентах; отдельный реестр пришлось бы синхронизировать.

### 4. Чистая логика сводки — `core/runs-summary.ts`
`buildDailySummary({ startSec, endSec, label })` → `{ summary, text }`:
- `summary`: общий итог + разбивка `perAgent[agentId].perSkill[type] = { runs, success, error, llmCalls, durationMs }`.
- `text`: человекочитаемый русский отчёт (агенты → скиллы; общий итог в шапке). Длинные значения не нужны (числа).
- Окно считает вызывающий (скрипт/инструмент): границы суток UTC+5 через смещение `+5h` (день = `[00:00, 24:00)` UTC+5 = `[19:00 пред., 19:00] UTC`).
- **Почему окно снаружи:** скрипт и пульт хотят разные окна (завершившийся день vs текущий до now) при одной агрегации.

### 5. Два пути доставки поверх одной логики
- **Standalone `src/scripts/daily-summary.ts --admin <agentId>`:** окно = **завершившийся** день UTC+5 (вчерашние сутки относительно момента запуска на границе дня); `buildDailySummary`; `TelegramService.loadAccount(adminAgentId)` + `sendSavedMessage(text)`; `disconnect`. systemd: `tg-daily-summary.service` (oneshot, `ExecStart=... daily-summary.ts --admin <agentId>`, `Slice=tg-agents.slice`) + `tg-daily-summary.timer` (`OnCalendar=*-*-* 19:00:00 UTC`, т.е. 00:00 UTC+5). `adminAgentId` подставляется при установке юнита (документируется в README).
- **OpenClaw-пульт `tg_daily_summary`:** окно = **текущий** день UTC+5 до `now`; возвращает `{ content:[{type:text,text}] }` с тем же `text`. Зарегистрирован в `index.ts`; скилл `skills/daily-summary/SKILL.md` описывает вызов на естественном языке. Опц. параметр `adminAgentId` не нужен для чтения (читаются все агенты); параметр окна опционален (дефолт — сегодня).

## Risks / Trade-offs

- **[Конкурентная запись в `runs` при параллельных прогонах разных агентов]** → каждый агент пишет в свою `tasks.db`, межагентной конкуренции нет; внутри агента прогон один (сериализация диспетчером). Чтение сводкой — readonly, не мешает.
- **[Чтение чужих `tasks.db` пультом из процесса OpenClaw]** → только чтение (readonly-коннект); файлы те же, к которым агент пишет — SQLite допускает конкурентное чтение.
- **[Рост таблицы `runs`]** → прогоны частые (heartbeat). Ретеншн вне scope; при необходимости — отдельная чистка `DELETE WHERE startedAt < …` (можно добавить позже).
- **[Зависимость от неархивированного `improve-skill-reports`]** → `durationMs`/`llmCalls` уже в коде диспетчера; дельты пишутся против baseline, конфликтов нет (новые файлы + точечная вставка в диспетчер).

## Migration Plan

1. Реализация кода (новые модули + точечная вставка в диспетчер + новый скрипт/инструмент/скилл) — обратносовместимо, схема `runs` создаётся идемпотентно при первом прогоне.
2. Деплой `src/*` на VPS обычным путём (`scp`/tar + перезапуск не требуется — диспетчер запускается таймером). Установка новых systemd-юнитов `tg-daily-summary.*` с подстановкой `--admin <agentId>` + `daemon-reload` + `enable --now ...timer` (ops-шаг, README).
3. Проверка: дождаться нескольких прогонов (записи в `runs`), вызвать пульт `tg_daily_summary` и/или дождаться таймера — сверить сводку в Saved Messages админа.

## Open Questions

- Ретеншн `runs` (через сколько дней чистить) — пока не чистим; решим по объёму.
- Точный `adminAgentId` — задаётся пользователем при установке таймера (параметр `--admin`).
