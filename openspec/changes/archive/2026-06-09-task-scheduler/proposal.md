## Why

Сейчас задачи `telegram-group-monitor`, `dm-send`, `dm-replies`, `account-warmup`, `join-queue` выполняет LLM-агент OpenClaw по cron. Агент на каждом прогоне ходит по десяткам инструментов — это дорого по токенам, хотя логика детерминирована, а LLM нужна только для генерации текста.

Цель — перенести логику в standalone TypeScript-скрипты, запускаемые планировщиком ОС напрямую — без участия агента. Экономия токенов на оркестрации: плановые прогоны ~100 %, ручные ~95 %. OpenClaw остаётся тонким пультом управления расписанием.

**Принцип: миграция, а не переработка.** Логика скиллов не меняется. Она переносится один-в-один из формата `SKILL.md` (где её исполняет LLM) в формат TypeScript-скрипта (где её исполняет код). Поведение, лимиты, пороги, паузы и обработка ошибок каждого скилла сохраняются. Единственное, что остаётся за LLM, — генерация текста и JSON (ответы, DM, скоринг, выбор сообщений).

## What Changes

- **Вынос логики в `core/`** — чистое ядро без импортов OpenClaw: Telegram-операции (GramJS), SQL-логика, загрузка конфига, пути к данным, интерфейс `Logger`. Используется и диспетчером, и плагином OpenClaw — одна копия логики.
- **Портирование скиллов в код** (`skills/`) — сегодняшние `SKILL.md` переписываются в TypeScript-функции (`runMonitor`, `runDmSend`, `runDmReplies`, `runAccountWarmup`, `runJoinQueue`) без изменения поведения (R-B2).
- **Диспетчер `scripts/dispatcher.ts`** — точка входа на агента (`--agent <agentId>`): выбирает назревшие задачи из БД и выполняет их последовательно в одном процессе.
- **Таблица расписания `tasks`** — хранит расписание в БД (cron-выражение + `tz`), а не в таймере; схему создаёт диспетчер при старте. Лежит в `~/.openclaw/workspace-<agentId>/tasks.db`.
- **systemd: сервис + таймер + slice** — один шаблонный юнит на агента (`tg-agent@.service`), heartbeat-таймер (`tg-agent@.timer`), общий slice ресурсов (`tg-agents.slice`).
- **OpenClaw-скилл как пульт управления** — не запускает задачу напрямую, а управляет строками в `tasks` и включает/выключает heartbeat-таймер агента.
- **LLM-слой** (`llm/`) — прямой вызов моделей через Vercel AI SDK + `openai-oauth-provider` (codex на подписке Plus, $0) + `ai-fallback`, без системных промптов OpenClaw; персона из `SOUL.md`.
- `index.ts` остаётся обёрткой над `core/` — без второй копии логики.

## Capabilities

### New Capabilities
- `task-scheduler`: Планировщик standalone-задач — диспетчер на агента, таблица расписания `tasks`, heartbeat-таймер systemd, slice ресурсов, OpenClaw-скилл как пульт управления расписанием.
- `llm-layer`: Вызов LLM из скриптов для генерации текста и JSON через AI SDK + codex OAuth + ai-fallback с общим `auth.json` и автоматическим рефрешем токена.

## Impact

- `src/core/` — новое чистое ядро: `telegram/`, `db/` (`channels`, `dm-threads`, `join-queue`, `replies`, `tasks`), `config.ts`, `logger.ts`
- `src/llm/` — `client.ts` (LlmClient), `prompts.ts` (каталог промптов)
- `src/skills/` — `monitor.ts`, `dm-send.ts`, `dm-replies.ts`, `account-warmup.ts`, `join-queue.ts`
- `src/scripts/dispatcher.ts` — точка входа диспетчера
- `src/index.ts` — OpenClaw-плагин становится тонкой обёрткой над `core/`
- `deploy/systemd/` — `tg-agent@.service`, `tg-agent@.timer`, `tg-agents.slice`
- `~/.openclaw/workspace-<agentId>/tasks.db` — новая БД расписания
- `~/.openclaw/codex-auth/auth.json` — общий OAuth-токен LLM-слоя
- `tsconfig.json` — убрать path-алиасы `../openclaw/...` после выноса типов
