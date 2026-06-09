## 1. Вынос логики в core/ (§7.1)

- [x] 1.1 Снять `definePluginEntry` — в скриптах не нужен (остаётся только в `index.ts`-обёртке; `core/` его не импортирует)
- [x] 1.2 Снять `api.registerTool` — функции зовутся напрямую (логика `core/` — обычные экспортируемые функции/методы; регистрация только в `index.ts`)
- [x] 1.3 Заменить формат `{ content: [...] }` на обычные объекты (`core/` возвращает обычные значения; `ok/fail`-обёртка только в `index.ts`)
- [x] 1.4 Заменить TypeBox-схемы `Type.Object` на обычные TS-аргументы (`core/` принимает обычные аргументы; TypeBox только в `index.ts`)
- [x] 1.5 Заменить тип `PluginLogger` своим интерфейсом `Logger { info, warn, error }` (`core/logger.ts`, инжектируется в `core/`)
- [x] 1.6 Убрать path-алиасы `../openclaw/...` в `tsconfig.json` после выноса типов (см. примечание ниже)
- [x] 1.7 Портировать как есть: GramJS-операции (connect, get_dialogs, get_messages, send_dm, reply), `peerCache`, `ensureClient` (`core/telegram/service.ts`)
- [x] 1.8 Портировать всю SQL-логику в `core/db/`: `channels`, `dm-threads`, `join-queue`, `replies` (модуль `tasks` не портируется — его SQL ещё не существует, таблицу создаёт диспетчер, см. раздел 3)
- [x] 1.9 Портировать загрузку `tg-account.json` и пути к данным в `core/config.ts`
- [x] 1.10 `index.ts` остаётся обёрткой над `core/` — без второй копии логики

> **Примечание к 1.6.** Алиасы `paths` в `tsconfig.json` указывали на dev-checkout
> `../openclaw/src` и использовались только `index.ts` (импорт `definePluginEntry`).
> После их удаления `index.ts` (единственный файл, связанный с OpenClaw) не
> резолвит типы `openclaw/*` локально — в рантайме их подставляет `jiti`.
> `core/` от OpenClaw полностью отвязан. Проект и ранее не собирался через `tsc`
> (несовместимые `module`/`moduleResolution` в `tsconfig`), поэтому на рантайм
> это не влияет. Если нужна типизация `index.ts` в IDE — алиас можно вернуть.

## 2. Портирование скиллов в skills/ (R-B2)

- [x] 2.1 `skills/monitor.ts` — `runMonitor` (логика `telegram-group-monitor` один-в-один)
- [x] 2.2 `skills/dm-send.ts` — `runDmSend`
- [x] 2.3 `skills/dm-replies.ts` — `runDmReplies`
- [x] 2.4 `skills/account-warmup.ts` — `runAccountWarmup`
- [x] 2.5 `skills/join-queue.ts` — `runJoinQueue` (конечная задача, R-A3)

> **Контракт LLM (раздел 7).** Скиллы зависят от интерфейса `LlmClient`
> (`src/llm/client.ts`, методы `complete`/`completeObject`) по DIP; конкретную
> реализацию (codex OAuth + ai-fallback) делает раздел 7. Промпты встроены в
> скиллы дословно из `SKILL.md` (верность R-B2); вынос в `llm/prompts.ts` (§6.6)
> — рефактор раздела 7.
>
> **Статус-модель вместо уведомления.** Скиллы возвращают `SkillStatus`
> (`src/skills/types.ts`); отчёт в Saved Messages и сдвиг `nextRun` делает
> диспетчер (R-D1, раздел 4) — «Шаг уведомления» из `SKILL.md` стал полем
> `details`. `runJoinQueue` при пустой очереди возвращает `terminal: true` (R-A3)
> вместо `CronList`/`CronDelete`.
>
> **Вынужденные детерминизации** (SKILL.md писался под LLM-агента, задокументированы
> в шапках файлов): `monitor` явно вызывает `telegram_get_dialogs` (peerCache +
> `readInboxMaxId`) и `saveReply` после общих ответов; `dm-replies` передаёт в
> `send_dm` `accessHash` из треда. Контекст (`SkillContext`: agentId, persona из
> SOUL.md, TelegramService, LlmClient, Logger) создаёт диспетчер (раздел 4).

## 3. Таблица расписания tasks (§3.3)

- [x] 3.1 Создать схему `tasks` (`agentId`, `type`, `schedule`, `tz`, `lastRun`, `nextRun`, `enabled`) с уникальностью по `(agentId, type)` и выборкой по `(enabled, nextRun)`, в `~/.openclaw/workspace-<agentId>/tasks.db` (`src/core/db/tasks.ts`: `ensureTasksSchema`, PK `(agentId, type)`, индекс `idx_tasks_due(enabled, nextRun)`)
- [x] 3.2 Реализовать пересчёт срока `nextRun = cronParser.parseExpression(schedule, { tz, currentDate: now }).next()` (`computeNextRun`; `cron-parser@^4` добавлен в `package.json` и установлен)

> Модуль `tasks.ts` также содержит операции таблицы для следующих разделов:
> `getDueTasks` (выборка назревших — диспетчер, 4.4), `advanceTask` (сдвиг
> `nextRun` всегда, R-D1 — 4.7), `disableTask` (терминальный статус, R-A3 — 4.7),
> `upsertTask` / `setTaskDueNow` / `countActiveTasks` (пульт-скилл, раздел 6).
> Сами диспетчер и пульт-скилл — разделы 4 и 6.

## 4. Диспетчер scripts/dispatcher.ts (§3.2)

- [x] 4.1 Точка входа `dispatcher.ts --agent <agentId>`
- [x] 4.2 Шаг 0: создать схему `tasks`, если её нет (идемпотентно)
- [x] 4.3 Шаг 1: загрузить `tg-account.json` агента
- [x] 4.4 Шаг 2: SELECT задачи где `enabled=1 AND nextRun <= now()`
- [x] 4.5 Шаг 3: если пусто → выйти (за секунду, токены не тратятся)
- [x] 4.6 Шаг 4: connect к Telegram (один клиент на весь прогон)
- [x] 4.7 Шаг 5: для каждой назревшей задачи последовательно — выполнить нужный `skills/*`, сформировать статус-модель и отправить отчёт в Saved Messages (R-D1), `UPDATE lastRun=now()`, сдвинуть `nextRun` всегда (R-D1), при терминальном статусе `enabled=0` (R-A3)
- [x] 4.8 Шаг 6: disconnect, выйти

> **Заглушка LLM в диспетчере (снять в разделе 7).** Раздел 4 реализован, но
> `SkillContext.llm` требует `LlmClient`, которого ещё нет (раздел 7). В
> `scripts/dispatcher.ts` вставлена заглушка `LlmClient`, бросающая явную ошибку
> (помечена TODO в коде). Последствие до раздела 7: скиллы с LLM (`monitor`,
> `account-warmup`, частично `dm-*`) отчитаются статусом `error` в Saved Messages,
> `nextRun` всё равно сдвигается (R-D1). Скиллы без LLM (`join-queue`) и холостой
> выход работают. **При выполнении 7.2** заменить заглушку на `createLlmClient()`
> — одна строка в `dispatcher.ts` (импорт + `const llm = createLlmClient(...)`).

## 5. systemd: сервис + таймер + slice (§3.5)

- [x] 5.1 `deploy/systemd/tg-agent@.service` — `Type=oneshot`, `ExecStart=... dispatcher.ts --agent %i`, `Slice=tg-agents.slice`, `TimeoutStartSec=3600`
- [x] 5.2 `deploy/systemd/tg-agent@.timer` — heartbeat `OnCalendar=*:0/10`, `RandomizedDelaySec=60`
- [x] 5.3 `deploy/systemd/tg-agents.slice` — `CPUQuota=60%`, `MemoryMax=1G`, `ConcurrencySoftMax=4`
- [x] 5.4 Установка юнитов: `cp` трёх файлов в `/etc/systemd/system/` + `systemctl daemon-reload` (ops-шаг на VPS, задокументирован в `deploy/README.md`; выполнено вручную)

## 6. OpenClaw-скилл — пульт управления (§3.6)

- [x] 6.1 Создать/обновить задачу: `INSERT ... ON CONFLICT(agentId, type) DO UPDATE SET schedule=excluded.schedule, enabled=1` (`core/db/tasks.ts:upsertTask`, обёрнут инструментом `tg_scheduler_upsert_task` + скиллом `scheduler-control`)
- [x] 6.2 Первая задача агента → `systemctl enable --now tg-agent@<agentId>.timer` (`core/scheduler-control.ts:createOrUpdateTask` — `countActiveTasks`===0 перед upsert)
- [x] 6.3 Внеплановый запуск → `UPDATE ... SET nextRun='now'` + `systemctl start tg-agent@<agentId>.service` (`triggerTaskNow`, инструмент `tg_scheduler_trigger_now`)
- [x] 6.4 Нет активных задач → `systemctl disable --now ...timer` (`removeTask` — `countActiveTasks`===0 после disable; инструмент `tg_scheduler_remove_task`)

> Реализация раздела 6: детерминированные решения (первая задача → enable,
> нет активных → disable) вынесены в `core/scheduler-control.ts` (не в натуральный
> язык скилла). Инструменты `tg_scheduler_*` зарегистрированы в `index.ts`;
> OpenClaw-скилл-пульт — `skills/scheduler-control/SKILL.md` (заменяет старые
> `*-cron-setup`). Дефолтные расписания перенесены 1:1 со старых cron-задач.
> Добавлен `core/db/tasks.ts:listTasks` для отображения расписания.

## 7. LLM-слой (llm-layer.md)

- [x] 7.1 Установить зависимости: `npm i ai openai-oauth-provider ai-fallback @ai-sdk/openai zod --ignore-scripts` (+ `tsx` для запуска диспетчера)
- [x] 7.2 `llm/client.ts` — `createFallback([ codex ])`, экспорт `complete()` и `completeObject()`. Примечание: openai-фолбэк закомментирован по решению (codex-only, без failover). `completeObject(opts, schema?)` — через `generateText` + извлечение JSON; при передаче zod-схемы валидирует ею; один повтор с ужесточённой инструкцией при невалидном JSON/схеме, иначе ошибка (R-D1). Схемы подключены в JSON-вызовах скиллов (monitor: выбор+скоринг, dm-replies: sentiment, account-warmup: выбор в батче)
- [x] 7.3 `llm/prompts.ts` — каталог промптов: `generateDM`, `generateThreadReply`, `generateReply`, `extractTopics`, `selectRelevantMessage` (JSON), `scoreForDM` (JSON), `generateDmReply` (+ варианты `generateThreadContinuation`, `analyzeSentiment`, `selectRelevantMessageInBatch`, `generateWarmupReply` — извлечены дословно из скиллов, R-B2). Все скиллы подключены к каталогу
- [x] 7.4 Авторизация: общий `~/.openclaw/codex-auth/auth.json`, `authFilePath` явно (в `client.ts`); первый логин `codex login` локально + `scp` на VPS; права `chmod 600`/`700` — задокументировано в `deploy/README.md`
- [x] 7.5 Персона: читать `SOUL.md` агента и передавать как `system`-сообщение (`dispatcher.readPersona` → `SkillContext.persona`, раздел 4)
- [x] 7.6 `OPENAI_API_KEY` фолбэка через systemd `EnvironmentFile=-/root/.openclaw/codex-auth/.env` (в `tg-agent@.service`)

## 8. Дисциплина перехода (§7.2)

- [x] 8.1 Пока агент не переведён полностью — обслуживается ЛИБО OpenClaw, ЛИБО скриптами (не оба одновременно — два клиента на одной сессии)
