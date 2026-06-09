## 1. Отчёт — длительность и человекочитаемый рендер (dispatcher)

- [x] 1.1 В `dispatcher.main` замерить длительность вокруг `skill(ctx)` (`t0 = Date.now()`, `durationMs`) и передать в `formatReport`
- [x] 1.2 Переписать `formatReport`: вместо `JSON.stringify(details)` — построчный рендер `Ключ: значение`, вложенные объекты подсписком с отступом
- [x] 1.3 Добавить длительность по-русски в шапку отчёта (рядом со статусом/`nextRun`)
- [x] 1.4 Добавить обрезку длинных текстовых значений (предел ~280 симв.) в рендере
- [x] 1.5 Добавить в `LlmClient` счётчик фактических запросов (инкремент на каждый `generateText`/`generateObject` в `client.ts`, включая ретраи) + чтение (`requestCount`)
- [x] 1.6 В `dispatcher.main` снять срез счётчика вокруг `skill(ctx)` (`llmCalls = llm.requestCount - before`) и передать в `formatReport`
- [x] 1.7 Вывести количество LLM-запросов по-русски в шапке отчёта
- [x] 1.8 Проверить, что отчёты `dm-send`/`dm-replies`/`join-queue` рендерятся читаемо без изменения их ключей (и `join-queue` показывает 0 LLM-запросов)

## 2. monitor — русские details и счётчики

- [x] 2.1 Завести счётчики «каналов с активностью» и «каналов пропущено (ошибки)» в `runMonitor` (помимо «обработано»)
- [x] 2.2 Разбить `repliesSent` по типам: новые треды / продолжения тредов / общие сообщения
- [x] 2.3 Сформировать `details` с русскими ключами: счётчики каналов, «ответов отправлено» {всего + 3 типа}, «dm-кандидатов добавлено» (число)

## 3. monitor — консолидация LLM-вызовов

- [x] 3.1 Добавить эвристический префильтр general-сообщений (короткие / только эмодзи / без буквенных символов) до LLM
- [x] 3.2 Добавить промпт `analyzeChannelMessages` в `llm/prompts.ts` (возврат `{ ответитьНа: {id,текст}|null, dmКандидаты: [{id,score,reason}] }`)
- [x] 3.3 В `runMonitor` заменить связку `extractTopics` + `selectRelevantMessage` + N×`scoreForDM` на один `completeObject(analyzeChannelMessages, schema)` на канал
- [x] 3.4 Отправлять не более одного ответа на канал (`ответитьНа` → один `generateReply` + `replyToMessage`); сохранить `saveReply`
- [x] 3.5 Скорить и записывать DM-кандидатов из `dmКандидаты` по прежнему порогу `score >= 0.6`, прежний набор полей `insertDmCandidate`
- [x] 3.6 Удалить `extractTopics` из monitor-пути (импорт и вызов); убрать `log.info` тем

## 4. account-warmup — русские details + текст ответа

- [x] 4.1 Перевести ключи `details` `runAccountWarmup` на русские
- [x] 4.2 Добавить поле «ответ» с текстом отправленного сообщения (когда ответ отправлен); не добавлять при отсутствии ответа

## 5. dm-replies — объединённый LLM-вызов

- [x] 5.1 Добавить промпт `analyzeAndReply(triggerMessage, history, newMessages)` в `llm/prompts.ts` (возврат `{ sentiment, ответ }`, при negative ответ пуст)
- [x] 5.2 В `runDmReplies` заменить `analyzeSentiment` + `generateDmReply` на один `completeObject(analyzeAndReply, schema)`
- [x] 5.3 Сохранить поведение: negative → `mark_as_read` + пропуск; positive → отправка готового ответа, обновление треда, `mark_as_read`
- [x] 5.4 Удалить из dm-replies-пути неиспользуемые `analyzeSentiment`/`generateDmReply` (если больше нигде не нужны)

## 6. Проверка

- [x] 6.1 `openspec validate improve-skill-reports` — без ошибок
- [x] 6.2 Прогон `monitor`/`dm-replies`/`account-warmup` (локально или на VPS): убедиться в Saved Messages, что отчёт читаем, есть длительность и новые поля
- [x] 6.3 Убедиться, что monitor делает один структурированный вызов на канал и не более одного ответа на канал