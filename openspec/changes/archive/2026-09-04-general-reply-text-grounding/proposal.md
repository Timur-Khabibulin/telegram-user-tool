## Why

`analyzeChannelMessages` выбирает одно общее сообщение для ответа и возвращает
структурированный `{ id, текст }`. Код (`monitor.ts`, `monitor-v2.ts`,
`monitor-v5.ts`) передаёт `текст` дальше как есть: в `generateReply(sel.текст)`
(промпт второго LLM-вызова), в `saveReply(..., msgText: sel.текст, ...)`
(`replies.db`), а в `monitor-v5.ts` ещё и в текст уведомления ревью-бота
(`formatGeneralReplyNotification`). Само сообщение при этом уже лежит в памяти
(`generalById`/`messages`, по `id`) — `текст` из ответа LLM не сверяется с ним.

На реальных данных VPS (`agent41`, `llm_log`, 2026-08-31 16:26) подтверждён
случай: источник — `id=74515 "Ну они ж разваляться через 2 дня"`, но LLM в
поле `текст` вернула «Да, вот это сразу видно. Я бы на такое даже не
смотрела…» — не то, что было в сообщении. `generateReply` сгенерировала ответ
на этот выдуманный текст, а `sendReply(chatId, sel.id, replyText)` отправила
его как reply на реальное `id=74515` — итоговый ответ агента в Telegram не
имеет отношения к сообщению, на которое он формально отвечает.

Один и тот же код (тот же `analyzeChannelMessages`/`generateReply`, то же
использование `sel.текст`) буквально скопирован в трёх местах: `monitor.ts`
(v1, строки 316-329), `monitor-v2.ts` (строки 503-513, наследует конвейер v1
без изменений), `monitor-v5.ts` (строки 578-609, с дополнительным
использованием `sel.текст` в уведомлении ревью-бота).

## What Changes

- Во всех трёх скиллах (`monitor.ts`, `monitor-v2.ts`, `monitor-v5.ts`) текст
  выбранного сообщения для `generateReply`, `saveReply` и (в v5)
  `formatGeneralReplyNotification` SHALL браться из реального сообщения по
  `id` (`generalById.get(sel.id).text` / эквивалент по месту), а не из поля
  `текст` в ответе LLM.
- Поле `текст` в схеме `analyzeChannelMessages` не убирается (используется
  моделью как часть рассуждения при выборе) — код просто перестаёт ему
  доверять как источнику содержимого сообщения.
- Если `sel.id` не находится среди сообщений, реально переданных в LLM
  (`generalById.get(sel.id)` вернул `undefined`) — выбор считается невалидным,
  ответ на общее сообщение в этом прогоне не отправляется (тот же класс
  защиты, что уже есть для DM-кандидатов без `userAccessHash`).

## Capabilities

### New Capabilities

(нет)

### Modified Capabilities

- `group-monitoring` (v1, архивирован в `openspec/specs/`) — добавляется
  требование о том, что текст для генерации ответа и сохранения в БД берётся
  по `id` из реальных сообщений, не из ответа LLM. Покрывает `monitor.ts` и
  `monitor-v2.ts` (последний переиспользует конвейер v1 без собственной
  спеки на этот механизм).
- `group-monitoring-v5` (ещё не архивирован — deltas лежат в
  `monitor-v5`/`monitor-v5-human-pacing-batching`/
  `monitor-v5-session-send-cap`) — модифицируется существующее требование
  "Reply decision and DM scoring on general messages match monitor v1
  exactly", тем же способом.

## Impact

- Код: `src/skills/monitor.ts`, `src/skills/monitor-v2.ts`,
  `src/skills/monitor-v5.ts` — три независимых, но механически одинаковых
  правки в блоке обработки `generalMessages`.
- Побочно чинится: исторически неверный `replies.db.msgText` для новых строк
  (старые записи не переписываются — не в скоупе), и в v5 — текст,
  показываемый ревьюеру в чате бота.
- Не затрагивает: `monitor-v3.ts`, `monitor-v4.ts` (не используют
  `analyzeChannelMessages`/`generateReply` для general-сообщений — работают с
  единственным известным постом напрямую, эта проблема там структурно не
  возникает).
- Не затрагивает: обработку `newThreadMessages`/`threadReplies` (используют
  `generateThreadReply`/`generateThreadContinuation` с текстом, уже взятым из
  реальных сообщений `TgMessage`, не из ответа LLM — там этой проблемы нет).
