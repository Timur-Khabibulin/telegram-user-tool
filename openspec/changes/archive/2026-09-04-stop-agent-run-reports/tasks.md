## 1. `dispatcher.ts`: убрать отчёт в Saved Messages

- [x] 1.1 Удалить блок `tg.sendSavedMessage(formatReport(...))` вместе с окружающим try/catch (шаг 5 главного цикла)
- [x] 1.2 Удалить `formatReport`, `renderDetails`, `truncate`, `REPORT_TEXT_LIMIT` — проверить `grep` по `src/`, что больше нигде не используются
- [x] 1.3 Убедиться, что `insertRun` и строка в journald (`log.info([run] ...)`) остаются нетронутыми — они не зависят от удаляемого блока

## 2. `channel-cleanup.ts`: убрать финальный отчёт

- [x] 2.1 Удалить вызов `tg.sendSavedMessage(formatSummaryReport(...))` в конце `runChannelCleanup`
- [x] 2.2 Удалить `formatSummaryReport`, если больше нигде не используется (`grep` по `src/`)
- [x] 2.3 Обновить комментарий-todo в шапке файла (строки 7-11) — пункт 3 («сам отправляет отчёт») больше не актуален

## 3. `funnel-collect.ts`: гейт по ограничению на этапах 5-7

- [x] 3.1 Импортировать `getActiveRestriction` из `core/db/agent-restrictions`
- [x] 3.2 Перед блоком этапов 5-7 (текущий `try { ...MTProto... }`) добавить проверку: если `restriction_type` агента ∈ `{need_update_session, banned}` — пропустить блок целиком (не вызывать `tg.loadAccount`/MTProto), НЕ устанавливать `row.note5to7`
- [x] 3.3 `suspend` не входит в условие пропуска — блок выполняется как обычно
- [x] 3.4 Убедиться, что этапы 1-4 (локальные БД) не затронуты этой проверкой — выполняются независимо от ограничения

## 4. Нормативные спеки

Дельты уже готовы в `openspec/changes/stop-agent-run-reports/specs/*` (созданы на
этапе proposal, провалидированы `openspec validate --strict`). `openspec archive`
сам сливает дельты в `openspec/specs/` — ручное редактирование `openspec/specs/*`
сейчас привело бы к двойному применению при архивации, поэтому здесь только
проверка содержимого дельт, не правка основных спек.

- [x] 4.1 `specs/task-scheduler/spec.md` — дельта готова (переформулировка R-D1), применится при `openspec archive`
- [x] 4.2 `specs/skill-run-report/spec.md` — дельта готова (удаление всех требований капабилити), применится при `openspec archive`
- [x] 4.3 `specs/run-log/spec.md` — дельта готова (уточнение сценария «Сбой записи не валит прогон»), применится при `openspec archive`
- [x] 4.4 `specs/funnel-metrics/spec.md` — дельта готова (новое требование о пропуске по ограничению), применится при `openspec archive`
- [x] 4.5 `specs/funnel-report/spec.md` — дельта готова («Пометки о пропущенных данных»), применится при `openspec archive`

## 5. Design-документация

- [x] 5.1 `docs/design/task-scheduler/architecture-v1.md` — убрать/поправить упоминания отправки отчёта в Saved Messages как канала для рядовых агентов (строка про «три канала: логи ≠ отчёт (Saved Messages, R-D1) ≠ команды»)
- [x] 5.2 `docs/design/task-scheduler/requirements-v1.md` — поправить упоминание R-D1/Saved Messages в соответствии с новым поведением

## 6. Проверка

- [x] 6.1 `tsc --noEmit` — сверить с уже известными несвязанными ошибками среды (см. `telegram-error-handling` tasks.md 11.1), убедиться, что новых ошибок в изменённых файлах нет — подтверждено, все 39 ошибок совпадают с известным базовым набором, `dispatcher.ts`/`channel-cleanup.ts` в списке нет, единственная строка `funnel-collect.ts` — тот же бланкетный `better-sqlite3`-баг
- [x] 6.2 `grep -rn "sendSavedMessage" src/` — убедиться, что вызовы остались только в `daily-summary.ts` и `funnel-tracker.ts` (и, при необходимости, `channel-analysis/run.ts`, `funnel-report.ts` — не входят в скоуп этого change) — подтверждено
- [x] 6.3 ~~Ручной прогон диспетчера на VPS для одного агента с назревшей задачей~~ — снято пользователем, без ручной проверки
- [x] 6.4 ~~Ручной прогон `tg-funnel-tracker.service` на VPS~~ — снято пользователем, без ручной проверки
