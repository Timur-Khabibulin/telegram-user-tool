## Why

`tg-agent-create-proxy-provisioning` (задеплоено, ещё не заархивировано) убрало ручной ввод
прокси и текста `SOUL.md`, но оставило нетронутым Шаг создания структуры агента, унаследованный
из версии до этого change: регистрацию агента как разговорной сущности OpenClaw
(`openclaw agents add`, `agentDir` с `auth-profiles.json`/`models.json`), биндинг и `allowFrom`
на канал `agentsBot`, и создание конвенционных workspace-файлов разговорного OpenClaw-агента
(`AGENTS.md`, `HEARTBEAT.md`, `USER.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `TOOLS.md`, `MEMORY.md`).

Разбор архитектуры (explore-сессия) показал: персона-агент никогда не ведёт разговорную
OpenClaw-сессию — вся его работа идёт через systemd-таймер → `dispatcher.ts` →
`src/skills/*.ts` напрямую, без LLM tool-calling loop. Ни `listAgentIds()`, ни `dispatcher.ts`,
ни `createLlmClient()` (общий `codex-auth/auth.json` на всех агентов), ни health-monitor
гейтвея не читают `agents.list`/`agentDir`/биндинг. Живых cron-задач, которые могли бы создать
per-agent разговорную сессию (`openclaw cron add --agent ... --session isolated`), на VPS не
существует (`openclaw cron list` → `total: 0`). Канал `agentsBot` дополнительно уже забанен.
Вся эта регистрация — мёртвый вес, который тратит токены и время на создание агента без
функциональной пользы.

## What Changes

- Новый скилл `skills/tg-agent-create-v2/` — вторая версия процесса создания агента, отдельная
  от `skills/tg-agent-create/` (v1, остаётся без изменений и включённым). `tg-agent-create-v2`
  не вызывает `openclaw agents add`, не вычисляет и не устанавливает биндинг, не добавляет
  `telegram_user_id` в `channels.telegram.accounts.agentsBot.allowFrom`, не создаёт
  `~/.openclaw/agents/<agentName>/agent/` и не копирует в него `auth-profiles.json`/
  `models.json`.
- Создание структуры агента в v2 сводится к `mkdir -p ~/.openclaw/workspace-<agentName>/` —
  отдельный bash-скрипт для этого шага (`create-agent-scaffold.sh`) не нужен вообще, команда
  выполняется прямо в SKILL.md.
- В v2 не создаются конвенционные workspace-файлы разговорного OpenClaw-агента: `AGENTS.md`,
  `HEARTBEAT.md`, `USER.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `TOOLS.md`, `MEMORY.md` — ничто в
  `src/` их не читает.
- `skills/tg-agent-create-v2/scripts/verify-agent.sh` (копия v1 с правками): убираются проверки
  A1 (агент зарегистрирован в OpenClaw), A2 (`telegram_user_id` в `allowFrom`), A3 (биндинг
  настроен), B5 (agent-конфиги скопированы) — все они проверяют то, что v2 не создаёт. Остаются
  B1 (`tg-account.json` валиден), B2 (`SOUL.md` непустой); добавляется проверка существования
  каталога `workspace-<agentName>/`.
- `openclaw.json`: регистрируется новая запись `skills.entries["tg-agent-create-v2"]:
  {"enabled": true}`. Запись `tg-agent-create` (v1) остаётся включённой — обе версии доступны
  одновременно, выбор версии при вызове — на усмотрение того, кто запускает создание агента.

## Capabilities

### New Capabilities

- `tg-agent-create-v2`: вторая версия процесса создания агента — тот же флоу подбора прокси и
  авторизации, что в `tg-agent-create` (v1), но без регистрации агента как сущности OpenClaw:
  создаётся только `workspace-<agentName>/` с данными, которые реально читает операционный код
  (`tg-account.json`, `SOUL.md`, БД). Существует параллельно с `tg-agent-create` (v1), который
  остаётся без изменений.

## Impact

- Код: новый `skills/tg-agent-create-v2/SKILL.md`, новый `skills/tg-agent-create-v2/scripts/
  verify-agent.sh` (копия v1 с убранными проверками A1/A2/A3/B5). `skills/tg-agent-create/`
  (v1) не меняется. Отдельного `create-agent-scaffold.sh` в v2 нет — не нужен для одной команды.
- Конфигурация: `openclaw.json` — добавляется `skills.entries["tg-agent-create-v2"]`, запись
  v1 остаётся как есть. Агенты, созданные через v2, не появляются в `agents.list`/`bindings`/
  `channels.telegram.accounts.agentsBot.allowFrom`.
- Вне скоупа: удаление канала `agentsBot` из `openclaw.json`, ретроактивная чистка уже
  существующих ~45 агентов из `agents.list`/`bindings`/`allowFrom`, отключение/удаление v1 —
  отдельные административные действия, не часть этого change. `tg-agent-reauth` не меняется.
