## 1. Модуль `dispatcher_runs`

- [x] 1.1 Создать `src/core/db/dispatcher-runs.ts` по образцу `src/core/db/runs.ts`: idempotent `ensureDispatcherRunsSchema(agentId)`, создающая таблицу `dispatcher_runs` (`id`, `agentId`, `startedAt`, `taskTypes`, `peakRssKb`) в `tasksDbPath(agentId)`.
- [x] 1.2 Добавить `insertDispatcherRun(agentId, { startedAt, taskTypes, peakRssKb })` — запись одной строки, без побочных эффектов на существующие таблицы `tasks`/`runs`.

## 2. Интеграция в диспетчер

- [x] 2.1 В `src/scripts/dispatcher.ts` вызвать `ensureDispatcherRunsSchema(agentId)` рядом с существующими `ensureTasksSchema`/`ensureRunsSchema` (шаг 0 `main()`).
- [x] 2.2 После цикла `for (const task of due)` (после обработки всех назревших задач, до/внутри `finally`) добавить один замер `process.resourceUsage().maxRSS` и вызов `insertDispatcherRun` с `agentId`, `startedAt` (момент начала прогона, уже доступен), `taskTypes` — `due.map((t) => t.type).join(", ")`, `peakRssKb`.
- [x] 2.3 Обернуть вызов `insertDispatcherRun` в try/catch: сбой записи логируется через `log.error`, прогон продолжается штатно (не бросает исключение дальше).
- [x] 2.4 Убедиться, что при `due.length === 0` (холостой прогон, ранний `return`) вызов `insertDispatcherRun` не происходит — замер стоит строго после цикла обработки задач, холостой путь его не достигает.
