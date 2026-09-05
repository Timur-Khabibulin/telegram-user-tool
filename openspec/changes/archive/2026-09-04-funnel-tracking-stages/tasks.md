## 1. Константа периода обхода канала

- [x] 1.1 Добавить `CHANNEL_CHECK_PERIOD_SECONDS` в `src/core/config.ts` (259200)
- [x] 1.2 Заменить приватную `PERIOD_SECONDS` в да`src/skills/monitor.ts` на импорт из `config.ts`
- [x] 1.3 Заменить `DEFAULT_PERIOD_SECONDS` в `src/core/db/channels.ts` на ссылку на `CHANNEL_CHECK_PERIOD_SECONDS` (как дефолт параметра `getChannelsBatch`)

## 2. Модель данных: `channel_visits`

- [x] 2.1 Добавить схему таблицы `channel_visits` в `src/core/db/channels.ts` (`CREATE TABLE IF NOT EXISTS`, индекс по `chatId, visitedAt DESC`)
- [x] 2.2 Добавить функцию `recordChannelVisit(agentId, { chatId, outcome, messagesCount }, log)` в `src/core/db/channels.ts`
- [x] 2.3 Добавить функцию подсчёта визитов за день: `countVisitsToday(agentId, window)` (по `outcome`, всего и `active`)
- [x] 2.4 Добавить функцию `medianActivityRate(agentId, window)` — `activityRate` по визитам `outcome='active'` с более ранним визитом того же `chatId`, медиана по агенту

## 3. Модель данных: `send_errors`

- [x] 3.1 Добавить схему таблицы `send_errors` в `src/core/db/channels.ts` (`CREATE TABLE IF NOT EXISTS`, индексы по `occurredAt` и `chatId, occurredAt`)
- [x] 3.2 Добавить функцию `recordSendError(agentId, { chatId, source, errorCode }, log)` в `src/core/db/channels.ts`
- [x] 3.3 Добавить функцию `countSendErrorsToday(agentId, window)` и `groupSendErrorsByCode(agentIds, window)` (агрегация по всем агентам для блока «Ошибки за день»; реализовано per-agent + слияние на стороне отчёта)
- [x] 3.4 Добавить функцию `problemChannels(agentId, window)` — `GROUP BY chatId, errorCode`, JOIN с `channels.title` для названия

## 4. Интеграция в `monitor.ts`

- [x] 4.1 Вызвать `recordChannelVisit` в ветке «нет непрочитанных» (`outcome='empty'`)
- [x] 4.2 Вызвать `recordChannelVisit` + `recordSendError('get_messages_error')` в ветке ошибки `get_messages`
- [x] 4.3 Вызвать `recordChannelVisit` в ветке `messages.length === 0` (`outcome='empty'`) и в ветке с активностью (`outcome='active'`, `messagesCount`)
- [x] 4.4 Обернуть вызовы `sendReply` (шаги 5.4/5.5/5.6) в try/catch: при не-flood ошибке — `recordSendError` + `markChannelProcessed` + `continue` к следующему каналу; `FloodAbortError` пробрасывать как и сейчас
- [x] 4.5 Проверить, что существующий control flow (FloodAbortError прерывает весь прогон) не изменился

## 5. Интеграция в `dm-send.ts`

- [x] 5.1 Вызвать `recordSendError(source='dm_send')` в каждой ветке `if ("error" in sendResult)`, перед существующей логикой (`break`/`continue`/`stopReason`/`floodErrors`) — вставлено один раз в начале блока, покрывает все ветки
- [x] 5.2 Проверить, что `stopReason`/`floodErrors`/статусы кандидатов не изменились

## 6. Изоляция ошибок в `core/funnel-collect.ts`

- [x] 6.1 Разделить сбор по агенту на два независимых try/catch: этапы 1-4 (локальные БД) и этапы 5-7 (MTProto, существующий блок без изменения логики)
- [x] 6.2 Заменить одиночное поле `note` в `AgentFunnelRow` на `note1to4`/`note5to7`
- [x] 6.3 Добавить в `AgentFunnelRow` поля этапов 1-4: `channelsTotal`, `channelsVisited`, `channelsActive`, `activityRateMedian`, `sendErrors`
- [x] 6.4 Вызвать новые функции из §2-3 для заполнения этих полей внутри нового try-блока

## 7. Формат отчёта: текст

- [x] 7.1 Обновить рендер таблицы в тексте отчёта: колонки «Каналов», «Просм», «Активно» (count + медиана), «Отправлено», без «Группы»/«Личные»/«Просмотры поста»/«Подписчики канала» (заголовки сокращены под ширину мобильного + легенда — как в существующем коде)
- [x] 7.2 Добавить строку «Просмотры публичных каналов (сумма по агентам): +D (абсолют)» после таблицы
- [x] 7.3 Добавить строку «Заявки в приватный канал: +D (абсолют)» после таблицы (как и в v1, без изменений по сути)
- [x] 7.4 Добавить блок «Ошибки за день: тип×N, ...» (по `groupSendErrorsByCode`), пропускать блок, если ошибок нет
- [x] 7.5 Добавить блок «Проблемные каналы» (по `problemChannels`), пропускать блок, если пуст

## 8. Формат отчёта: CSV

- [x] 8.1 Реализовать построение CSV со всеми 7 этапами, дельта и абсолют — отдельные столбцы, заголовки = названия этапов без сокращений
- [x] 8.2 Заполнить строку `ИТОГО` в обоих столбцах (дельта и абсолют) для метрик-снапшотов
- [x] 8.3 Записать CSV-файл в `reportsDir(adminAgentId)` с именем по конвенции channel-content-analysis (UTC-timestamp)
- [x] 8.4 Отправить CSV через `sendSavedDocument` сразу после текста отчёта
