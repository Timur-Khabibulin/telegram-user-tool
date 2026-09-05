## 1. Конфигурация

- [x] 1.1 Добавить `REPORT_AGENT_ID = "agent27"` в `src/core/config.ts`, рядом с `FUNNEL_ADMIN_AGENT_ID`
- [x] 1.2 В `listAgentIds()` исключить `REPORT_AGENT_ID` из возвращаемого списка (`.filter((id) => id !== REPORT_AGENT_ID)`)
- [x] 1.3 Обновить комментарий над `FUNNEL_ADMIN_AGENT_ID`: убрать формулировку «получатель отчёта-воронки», оставить только «владелец `funnel.db`/`discovery.db`/`reports/`, права на приватный канал»
- [x] 1.4 Добавить комментарий над `REPORT_AGENT_ID`, описывающий обе гарантии: исключён из `listAgentIds()`, не может быть запущен диспетчером/поставлен в расписание (ссылка на 2.1/3.1)

## 2. Guard: `dispatcher.ts`

- [x] 2.1 В начале `main()`, до `ensureTasksSchema`/`ensureRunsSchema`/`tg.loadAccount` — проверка `agentId === REPORT_AGENT_ID`, при совпадении `throw new Error(...)` с текстом, объясняющим причину (агент зарезервирован для отчётов, задачи не выполняет)
- [x] 2.2 Проверить, что процесс завершается без подключения к Telegram и без обращения к БД агента (guard строго до шага 0 текущего потока)

## 3. Guard: `scheduler-control.ts`

- [x] 3.1 В `createOrUpdateTask` — та же проверка в начале функции, до `ensureTasksSchema`/`upsertTask`, тот же текст ошибки, что в 2.1
- [x] 3.2 Не добавлять аналогичную проверку в `removeTask`/`triggerTaskNow` — эти пути должны оставаться доступными без исключений (см. design.md §Decisions)

## 4. Отправитель отчёта: `funnel-tracker.ts`

- [x] 4.1 Добавить парсинг `--send-as`, значение по умолчанию — `REPORT_AGENT_ID`
- [x] 4.2 Заменить `tg.loadAccount(adminAgentId)` перед отправкой (текст + CSV) на `tg.loadAccount(sendAsAgentId)`
- [x] 4.3 Не менять `ensureFunnelSchema(adminAgentId)`, `collectFunnel(..., adminAgentId, ...)`, `reportsDir(adminAgentId)` — продолжают использовать `adminAgentId` (по умолчанию `FUNNEL_ADMIN_AGENT_ID`)
- [x] 4.4 Обновить лог-сообщение (`[funnel-tracker] sent funnel for ... to admin ...`) и комментарий в шапке файла — отразить разделение «данные (`--admin`) / получатель (`--send-as`)»

## 4a. Отправитель отчёта: `index.ts` (интерактивные инструменты плагина)

Обнаружено в процессе реализации — не было учтено в design.md/proposal.md на этапе
проектирования (см. design.md «Дополнение по итогам реализации»).

- [x] 4a.1 Импортировать `REPORT_AGENT_ID` в корневом `index.ts`
- [x] 4a.2 `tg_funnel_report`: заменить `tg.loadAccount(FUNNEL_ADMIN_AGENT_ID)` на `tg.loadAccount(REPORT_AGENT_ID)` перед `sendSavedMessage`/`sendSavedDocument`; `reportsDir(FUNNEL_ADMIN_AGENT_ID)` не менять (владелец данных)
- [x] 4a.3 `tg_funnel_report`: обновить текст описания инструмента и текст подтверждения (`Отчёт-воронка ... отправлен в Избранное ...`) — убрать хардкод `agent1`/«admin agent»
- [x] 4a.4 `tg_channel_coverage_report`: заменить `tg.loadAccount(FUNNEL_ADMIN_AGENT_ID)` на `tg.loadAccount(REPORT_AGENT_ID)`, обновить текст описания инструмента
- [x] 4a.5 Задеплоить обновлённый `index.ts` на VPS и выполнить `openclaw gateway restart` — по ходу обнаружено и стабилизировано **не связанное** с этим change падение гейтвея (`openclaw.service` не поднимался с 2026-07-08 из-за конфликта systemd-юнита и процесса, управляемого `openclaw gateway restart`, за порт 18789); подробности вне tasks.md этого change, требует отдельного разбора

## 5. Отправитель отчёта: `daily-summary.ts`

- [x] 5.1 Заменить `parseAdminAgentId` (обязательный `--admin`, бросает при отсутствии) на парсинг `--send-as` с дефолтом `REPORT_AGENT_ID` (по образцу `parseArg` из `funnel-tracker.ts`)
- [x] 5.2 Заменить `tg.loadAccount(adminAgentId)` на `tg.loadAccount(sendAsAgentId)`
- [x] 5.3 Обновить лог-сообщение и комментарий в шапке файла (`Запуск: tsx daily-summary.ts --send-as <agentId>`)

## 6. systemd-юниты

- [x] 6.1 `deploy/systemd/tg-funnel-tracker.service`: добавить `--send-as agent27` в `ExecStart`, `--admin agent1` оставить как есть
- [x] 6.2 `deploy/systemd/tg-daily-summary.service`: заменить `--admin agent1` на `--send-as agent27` в `ExecStart`
- [x] 6.3 Обновить комментарии-заголовки в обоих юнитах (снять формулировку «здесь: agent1» применительно к получателю)

## 7. Деплой и проверка

- [x] 7.1 Скопировать на VPS изменённые файлы: `src/core/config.ts`, `src/scripts/funnel-tracker.ts`, `src/scripts/daily-summary.ts`, `src/scripts/dispatcher.ts`, `src/core/scheduler-control.ts`; `chown root:root`
- [x] 7.2 Скопировать обновлённые systemd-юниты, `systemctl daemon-reload`
- [x] 7.3 Ручной прогон `tsx funnel-tracker.ts --admin agent1 --send-as agent27 --private-channel <id>`: отчёт (текст + CSV) пришёл в Saved Messages `agent27`; `funnel.db`/`reports/` в `workspace-agent1` обновились как раньше. Подтверждено логом: `agent27` пропущен в обходе метрик (после agent26 сразу agent28), загружен отдельно только на шаге отправки, финал — `sent funnel for 2026-07-16 (data: agent1) to agent27`
- [x] 7.4 Ручной прогон `tsx daily-summary.ts --send-as agent27`: сводка пришла в Saved Messages `agent27`
- [x] 7.5 Проверка guard'а диспетчера: `tsx dispatcher.ts --agent agent27` завершается ошибкой немедленно, без обращения к Telegram
- [x] 7.6 Проверка guard'а пульта: попытка поставить задачу `agent27` через `createOrUpdateTask` (пульт/`tg_*` инструмент) отклоняется с тем же текстом ошибки

## 8. Документация

- [x] 8.1 `docs/configuration.md`: добавить `REPORT_AGENT_ID` в таблицу констант `src/core/config.ts`, рядом с `FUNNEL_ADMIN_AGENT_ID`
- [x] 8.2 `docs/operation.md`: в описании `funnel.db`/`discovery.db`/`reports/` (таблица «Данные агента») убрать формулировку, подразумевающую, что владелец данных — он же получатель отчёта

## 9. Выполнено операционно (до кода, 2026-07-17)

- [x] 9.1 `agent27`: задача `account-warmup` отключена (`enabled=0`) в `tasks.db`
- [x] 9.2 `agent27`: `tg-agent@agent27.timer` остановлен и отключён (`systemctl disable --now`, статус `disabled`/`inactive`)
