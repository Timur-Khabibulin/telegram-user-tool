## 1. Конфигурация и схема данных

- [x] 1.1 В `src/core/config.ts` добавить путь `distributionDbPath(adminAgentId)` и путь каталога `distribution-uploads/` (по образцу `discoveryDbPath`/`reportsDir`)
- [x] 1.2 В `src/core/config.ts` добавить чтение `CHANNEL_DISTRIBUTION_CHAT_ID` из `process.env` (`secrets.env`), по образцу `TELEGRAM_REVIEW_CHAT_ID`
- [x] 1.3 В `src/core/db/discovery.ts` добавить аддитивную миграцию колонки `metrics_json TEXT` в `discovered_channels` и функцию записи метрик JSON-объектом; легаси фикс-колонки оставить нетронутыми
- [x] 1.4 Создать `src/core/db/distribution.ts`: схема `channel-distribution.db` с таблицей `distribution_tasks` (status, file_path, agents_spec, requester_id, added/skipped/error_count, created_at, finished_at)
- [x] 1.5 В `db/distribution.ts` — функции: создать задачу (`running`), проверка «есть незавершённая» (R24), обновить счётчики и статус `done`, прочитать статус/сводку

## 2. Балансировка

- [x] 2.1 Создать `src/features/channel-distribution/plan.ts`: чистая функция water-fill (вход — набор агентов + стартовая нагрузка `assignmentCounts` + список каналов; выход — раскладка канал→агент), тай-брейк по меньшему `agentId`, детерминированность

## 3. Оркестрация распределения

- [x] 3.1 Создать `src/features/channel-distribution/run.ts`: парсинг CSV (разделители `,` `;` `\t`, колонка `link` по заголовку, прочие колонки → метрики)
- [x] 3.2 В `run.ts` — разбор набора агентов (список и/или диапазоны `agentId`), валидация против `listAgentIds()` с отклонением при неизвестном (R17)
- [x] 3.3 В `run.ts` — валидация формата ссылки `t.me/<channelusername>` через `normalizeChannelLink` + предикат отбраковки `t.me/+`/`joinchat`/`t.me/c/`/пустого username (R15)
- [x] 3.4 В `run.ts` — классификация исхода строки (added/skipped/error) по правилам R11/R12/R13/R14/R15 с дедупом в пределах файла и проверкой `getChannelStatus`
- [x] 3.5 В `run.ts` — вызвать `plan.ts` на отобранных к добавлению каналах; для added: `registerChannel` + запись метрик `metrics_json`
- [x] 3.6 В `run.ts` — постановка в очередь батчем: группировка по агенту и один `addJoinQueue(agent, [...])` на агента (R7)
- [x] 3.7 В `run.ts` — для каждого агента с ≥1 каналом обеспечить включение задачи `join-queue` (`upsertTask`/`computeDefaultSchedule("join-queue")`, R8)
- [x] 3.8 В `run.ts` — запись счётчиков исходов в `distribution_tasks`, детализация по каналам в stdout (journald), фиксация частичного успеха (R25)

## 4. Bot API-клиент

- [x] 4.1 Создать `src/core/distribution-bot-api.ts` (образец `core/review-bot-api.ts`): `getUpdates` (long-poll), приём `message` с `document`, `getFile` + скачивание файла, `sendMessage`
- [x] 4.2 В `distribution-bot-api.ts` — фильтр по `chat.id` = `CHANNEL_DISTRIBUTION_CHAT_ID`, default-deny (R18)

## 5. Listener и поток

- [x] 5.1 Создать `src/scripts/periodic/distribution-listener.ts` (persistent-сервис, образец `review-listener.ts`): цикл `getUpdates`, авторизация по чату
- [x] 5.2 Реализовать command-initiated поток: спец-команда → режим приёма, стартовое сообщение с предупреждением «файл ≤ 20 МБ»
- [x] 5.3 Приём файла → сохранение в `distribution-uploads/` (R26), валидация формата CSV/колонки `link`, отклонение с причиной (R16)
- [x] 5.4 Проверка R24 (одна задача), создание строки задачи, инлайн-вызов `features/channel-distribution/run.ts`
- [x] 5.5 Ответ на запрос статуса (R10) и выдача сводки по количествам в тот же чат по завершении (R9)

## 6. Деплой

- [x] 6.1 Создать `deploy/systemd/tg-distribution-listener.service` (`Type=simple`, `Restart=always`, образец `tg-review-listener.service`)

## 7. Документация

- [x] 7.1 Обновить `docs/operation.md` (новый сервис/юнит, каталог загрузок, журнал) и `docs/configuration.md` (bot-токен, `CHANNEL_DISTRIBUTION_CHAT_ID`)
- [x] 7.2 Обновить `docs/architecture.md` при необходимости (новый компонент listener + хранилище прогонов) — правка не потребовалась: обобщённая карта слоёв уже покрывает `periodic/`-процесс и Bot API-клиент в `core/`; полный HOW — в `docs/design/channel-distribution/architecture.md`
