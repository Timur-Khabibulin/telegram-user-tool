## 1. Google Sheets: доступ и конфиг

- [x] 1.1 Сервис-аккаунт Google заведён, лист расшарен, ключ на VPS (`/root/.openclaw/google-sheets-key.json`) — доступ подтверждён смоук-тестом (дедуп прочитал 2971 ссылку)
- [x] 1.2 Добавить в конфиг/секреты ID таблицы, имя листа и путь к JSON-ключу (`src/core/config.ts` + `docs/configuration.md`)
- [x] 1.3 ~~Добавить зависимость `googleapis`~~ → **уточнение**: без новой зависимости — авторизация JWT сервис-аккаунта через `node:crypto` + Sheets REST через `fetch` (тяжёлый `googleapis` не оправдан ради нескольких вызовов; нативные пересборки на проекте болезненны)

## 2. Модуль интеграции Google Sheets (`src/core/google-sheets.ts`)

- [x] 2.1 Модуль авторизации по JSON-ключу сервис-аккаунта (JWT RS256 `node:crypto` → access-token, scope `spreadsheets`, кэш токена)
- [x] 2.2 Чтение колонки `link` листа для дедупа (`values.get` по позиции колонки из заголовка), нормализация через `normalizeChannelLink`
- [x] 2.3 Пакетная дозапись строк результата (`values.append`, RAW) с маппингом по имени/позиции колонки заголовка; несчитаемые метрики и `assigned_agent`/`reestr_sub_count` — пустые ячейки; числа как числа
- [x] 2.4 `ensureColumns` — гарантия набора колонок в заголовке (недостающие добавить); пишем только английские имена, `статус`/`в_discovery_db`/`is_broadcast` не трогаем; `date_updated` = дата прогона проставляет воркер

## 3. Объединённый скрипт метрик

> **Уточнение дизайна:** ядро расчёта уже есть — `features/channel-metrics/run.ts`
> (`measureChannel`) считает subs/avg_views/comments_open/is_broadcast + нишу за один
> резолв. Не «портируем channel-niche», а **расширяем это ядро активностью** и
> оборачиваем в волновую модель `channel-niche` (очередь/session-lock/FLOOD).

- [x] 3.1 Волновой воркер по пулу агентов (каркас `channel-niche.ts`: общая очередь, session-lock, FLOOD, резюм) — `src/features/channel-full-metrics/run.ts`
- [x] 3.2 `measureChannelFull`: subs/avg_views/comments_open/is_broadcast/ниша + `getPostsSince(30д)` при `linkedChatId` → `posts_30d`/`total_comments`/`comments_per_day`
- [x] 3.3 Построчная запись в output-CSV (11 колонок); резюмируемость по обработанным ссылкам; несчитаемые поля — пусто; приватные/не найдены — строка с `error`
- [x] 3.4 Приём `agentIds` пула + предохранители `POSTS_MAX_REQUESTS/POSTS_MAX_POSTS`

## 4. Хранилище задач пайплайна (`src/core/db/metrics-pipeline.ts`)

- [x] 4.1 Таблица `metrics_pipeline_tasks`: id, статус, агенты, колонка-фильтр, порог, total, processed, passed_count, пути входа/выхода/результата, requester, created/finished, error
- [x] 4.2 Функции: `createPipelineTask`, `updatePipelineProgress`, `finishPipelineTask`, `getLatestPipelineTask`/`getPipelineTask`, `hasUnfinishedPipelineTask` (guard)

## 5. Пайплайн-воркер (отдельный процесс)

- [x] 5.1 Воркер `src/scripts/ops/metrics-pipeline-worker.ts`: дедуп (fail-fast) → расчёт → фильтр → запись в лист → выходной CSV → отчёт в чат
- [x] 5.2 Обновление прогресса задачи в БД по ходу расчёта (колбэк `onProcessed` → `updatePipelineProgress`)
- [x] 5.3 Логика фильтра: числовая колонка `>` порог; пустая/нечисловая метрика → `прошёл_фильтр=FALSE`
- [x] 5.4 Финальный CSV прошедших (`link` + метрики) в `result-<id>.csv`

## 6. Команда бота в distribution-listener

- [x] 6.1 Команда `/metrics` + приём одним сообщением (CSV + подпись), тот же уполномоченный чат (авторизация в bot-api)
- [x] 6.2 `parseMetricsParams` + валидация до старта: агенты (`listAgentIds`), колонка (из числовых), порог (число); понятные отказы
- [x] 6.3 Создание задачи + `spawnMetricsWorker` (detached); guard `hasUnfinishedPipelineTask`
- [x] 6.4 Команда `/metrics_status`: прогресс из БД (посчитано N из M), переживает рестарт слушателя
- [x] 6.5 `sendDistributionDocument` (multipart) — CSV в чат; текстовое сообщение, если прошедших нет

## 7. Проверка и деплой (требует VPS + креды — вне текущей сессии)

- [x] 7.3 Деплой: файлы залиты на VPS, секреты в `secrets.env` (`GOOGLE_SHEETS_KEY_PATH`/`CHANNELS_SHEET_ID`/`CHANNELS_SHEET_NAME` = точная вкладка), `tg-distribution-listener` перезапущен; воркер — detached из слушателя (отдельный юнит не нужен)
- [x] 7.4 Документация: `docs/operation.md` (строка `tg-distribution-listener` — конвейер метрик, команды, воркер, файлы/БД), `docs/configuration.md` (секреты)
