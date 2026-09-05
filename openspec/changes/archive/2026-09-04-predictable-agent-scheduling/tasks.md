## 1. Дефолты расписания

- [x] 1.1 `src/core/db/tasks.ts`: `DEFAULT_PERIODIC_SCHEDULE["join-queue"].periodMinutes` — 180 → 240.
- [x] 1.2 `src/core/db/tasks.ts`: `DEFAULT_CALENDAR_SCHEDULE["leave-banned"].schedule` — `"0 5 * * *"` → `"0 1 * * *"`.
- [x] 1.3 `src/scripts/backfill-schedule-defaults.ts` — разовый скрипт: находит строки `join-queue`/`leave-banned`, совпадающие со старым дефолтом (join-queue — любой из старых 18 round-robin слотов при периоде 180 мин; leave-banned — ровно `"0 5 * * *"`), пересчитывает на новый дефолт через `upsertTask`; несовпавшие (предполагаемо кастомные) — пропускает и логирует отдельно. Не запущен на проде — требует отдельного подтверждения перед прогоном на VPS.

## 2. Тихие часы — расчёт `nextRun`

- [x] 2.1 `src/core/db/tasks.ts`: добавить константы окна (начало/конец часа, tz — Asia/Yekaterinburg) и список исключений (`leave-banned`).
- [x] 2.2 `src/core/db/tasks.ts`: реализовать `nextRunOutsideQuietHours(schedule, tz, from, type)` — обёртка над `computeNextRun`, пересчитывающая вперёд, пока результат попадает в окно (кроме `type === 'leave-banned'`).
- [x] 2.3 `upsertTask`: использовать `nextRunOutsideQuietHours` вместо прямого `computeNextRun` для начального `nextRun`.

## 3. Pre-advance `nextRun` (до выполнения скилла)

- [x] 3.1 `src/core/db/tasks.ts`: `advanceTask` переработан на месте (без отдельной `preAdvanceTask` — та же функция, тот же контракт вызова из диспетчера) — теперь читает текущий `nextRun` строки и считает новый через `nextRunOutsideQuietHours(schedule, tz, from=строка.nextRun, type)` (база — предыдущее плановое значение, не факт вызова), пишет в БД сразу.
- [x] 3.2 `src/scripts/dispatcher.ts`: вызов `advanceTask(...)` перенесён в начало итерации цикла по `due`, до `skill(ctx)` (было — после обработки задачи).
- [x] 3.3 Проверено: `formatReport`/отчёт в Saved Messages получает `nextRun`, посчитанный в начале итерации — формат отчёта не менялся.
- [x] 3.4 Терминальный статус (`status.terminal` → `disableTask`) остался после скилла, не перенесён в pre-advance.

## 4. Метрики CPU по скиллу

- [x] 4.1 `src/core/db/runs.ts`: схема `runs` дополнена колонками `cpuUserMs`/`cpuSystemMs` (аддитивная миграция через `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`, т.к. SQLite не умеет `ADD COLUMN IF NOT EXISTS`).
- [x] 4.2 `src/core/db/runs.ts`: `insertRun`/`RunRow`/`getRunsBetween` расширены под новые поля.
- [x] 4.3 `src/scripts/dispatcher.ts`: `process.cpuUsage()` снимается до вызова скилла и передаётся в `process.cpuUsage(cpuBefore)` после — Node сам считает разницу; в мс через `/1000`, передаётся в `insertRun`.

## 5. Потолок параллелизма — `flock`

- [x] 5.1 `deploy/systemd/tg-agents-slots.conf` — декларативное `systemd-tmpfiles.d` правило: каталог `/run/tg-agents/` и `C=16` файлов-слотов (`slot-0` … `slot-15`).
- [x] 5.2 `deploy/systemd/tg-agent@.service`: `ExecStart` обёрнут перебором слотов через `flock -n <slot> -c "..."` (первый успешный захват — исполнение; все заняты — тихий выход, `exit 0`, без исполнения).
## 6. `MemoryMax` слайса

- [x] 6.1 `deploy/systemd/tg-agents.slice`: `MemoryMax` — `2G` → `3420M` → **откат обратно на `2G`**.
- [x] 6.2 Задеплоено на VPS: `3420M` вызвал реальный system-wide OOM (VPS — 3.8 ГБ RAM всего, не 4 ГБ; 3420 МБ слайсу не оставляли системе достаточно памяти) — убило `openclaw-gateway` и даже `sshd`-сессию (`dmesg`: `global_oom`, `CONSTRAINT_NONE`, вне `tg-agents.slice`). Немедленно откачено обратно на `2G` и на VPS, и в репозитории; система стабилизировалась (load average 155 → 66, gateway `active`). **Целевой потолок 3420 МБ из `docs/task-scheduling.md` не подтвердился на реальном железе — модель требует пересчёта под фактические ~3.8 ГБ RAM, решение не принято.**

## 7. Документация

- [x] 7.1 `docs/task-scheduling.md`: убрана пометка «Статус: … реализация ещё не внесена»; таблица N_max синхронизирована с фактическим join-queue=4ч. **Требует ещё одной правки** — целевой `MemoryMax=3420 МБ` в разделе «Модель ресурсов и ёмкости» опровергнут инцидентом (см. 6.2), не обновлено.
- [x] 7.2 `docs/operation.md`: обновлена таблица systemd-юнитов (`tg-agents-slots.conf`, описание `flock`-семафора вместо недействующего `ConcurrencySoftMax`; заодно поправлено расходившееся с кодом `RandomizedDelaySec` таймера). `MemoryMax` в таблице оставлен как `2G` (фактическое значение после отката).
- [x] 7.3 `skills/scheduler-control/SKILL.md`: добавлена заметка про тихие часы в «Ограничения и заметки».

## 8. Проверка
