## Context

`leave-banned-channels` (`src/skills/leave-banned-channels.ts`) сейчас:
работает раз в сутки (`DEFAULT_CALENDAR_SCHEDULE["leave-banned"] = "0 1 * * *"`,
единственная задача в `QUIET_HOURS_EXEMPT_TASKS`); источник работы — таблица
`banned_channels` (`chatId` PK, `detectedAt`), читается целиком без лимита
(`getBannedChannels`, `ORDER BY detectedAt ASC`); цикл `resolveChannelUsername`
→ `leaveChannel` → `purgeChannelData` → `markChannelBanned` (реестр) →
`deleteBannedChannel` не содержит пауз ни между шагами, ни между каналами.

`channels.status` (та же `tg-channels.db`) уже параллельно несёт факт бана:
`markChannelStatus(agentId, chatId, "banned", log)` вызывается синхронно с
`enqueueBannedChannel` в обоих местах кода, где это вообще происходит
(`src/skills/monitor-v2.ts:292-293`, `src/core/post-comment-send.ts:84-85`) —
расхождений между двумя источниками в текущем коде нет.

Прецедент человекоподобного темпа уже принят для `monitor-v5`
(`monitor-v5-human-pacing-batching`, в работе): чанки сообщений случайного
размера, паузы между шагами и итерациями, вместо мгновенных пакетных вызовов.
Этот change переносит тот же принцип на `leave-banned-channels`, с
самостоятельными (не скопированными бездумно) числовыми диапазонами и
структурой цикла — сценарий другой: не «дочитать реальный непрочитанный
хвост», а «оставить правдоподобный след активности перед выходом».

Нормативная спека `leave-banned-channels` не заархивирована в
`openspec/specs/` — ближайший источник истины:
`openspec/changes/leave-banned-channels/specs/leave-banned-channels/spec.md`.

## Goals / Non-Goals

**Goals:**
- Период `leave-banned` — 180 минут (3ч), задача остаётся в
  `QUIET_HOURS_EXEMPT_TASKS`.
- Источник очереди — `channels.status IN ('banned', 'should_leave')` вместо
  таблицы `banned_channels`; `banned_channels` и её функции удаляются.
- Лимит батча — 20 каналов за прогон.
- Паузы: `resolveChannelUsername` → `leaveChannel` — всегда `random(10,20)`с;
  опционально (случайный гейт per-канал) 1–3 батча `getMessages` по
  `random(7,15)` с `markAsRead` на каждый батч и паузой `random(3,7)`с между
  батчами, до паузы `leaveChannel`; между каналами — `random(2,7)`с.

**Non-Goals:**
- Кто и когда проставляет `should_leave` — вне скоупа (внешний источник, не
  этот код).
- `getChannelsBatch`/monitor-v2 не меняются — `should_leave` НЕ добавляется в
  исключение обработки монитором (явно отклонено в обсуждении).
- Согласование дублирующих копий требования «CHAT_WRITE_FORBIDDEN →
  `banned_channels`» в незаархивированных `monitor-v5`, `telegram-error-handling`,
  `post-comment-review` — вне скоупа, см. proposal.md → Impact.
- Логика самого выхода (`leaveChannel`, порядок leave-до-purge, что удаляется/
  сохраняется) не меняется — меняется только источник очереди, лимит и темп.

## Decisions

**1. Источник очереди — прямой `SELECT` по `channels.status`, без
промежуточной таблицы.**
```sql
SELECT chatId FROM channels
WHERE status IN ('banned', 'should_leave')
ORDER BY statusUpdatedAt ASC
LIMIT ?
```
Переиспользует уже существующие колонки (`status`, `statusUpdatedAt`) вместо
второй таблицы с тем же фактом — «один факт — один дом». `ChannelStatus`
(`src/core/db/channels.ts:37`) расширяется значением `"should_leave"`.
*Альтернатива отклонена*: оставить `banned_channels` как отдельную очередь и
просто расширить её `should_leave`-строками — сохраняет дублирование, не
чинит исходную проблему.

**2. Сброс статуса — прямой `UPDATE`, симметрично `expireChannelStatuses`.**
После успешного `leaveChannel` + `purgeChannelData`:
```sql
UPDATE channels SET status = NULL, statusUpdatedAt = NULL,
       statusDurationSeconds = NULL, status_description = NULL
WHERE chatId = ?
```
Канал больше не забанен и не ожидает выхода — статус снимается целиком, не
только `status`. Если `leaveChannel` завершился ошибкой — статус НЕ трогаем,
канал естественно останется в следующей выборке (то же поведение, что раньше
давала неудалённая строка `banned_channels`).

**3. Лимит батча — 20, `LIMIT` в запросе, без отдельного `processing`-статуса
(в отличие от `join_queue`).**
`join_queue` использует промежуточный статус `processing` + reset по таймауту,
потому что несколько прогонов теоретически могут пересекаться. Здесь этого не
вводим: `leave-banned` — единственный писатель/читатель `status IN ('banned',
'should_leave')` в рамках одного прогона одного агента, а конкурентного
запуска нескольких прогонов одного скилла на одном агенте система не
предполагает (тот же принятый риск, что и в `monitor-v5` design.md —
ответственность оператора). *Альтернатива отклонена*: полноценная
`processing`-модель как в `join_queue` — оверинжиниринг для очереди, которая
не показывает признаков конкурентных гонок на практике.

**4. Батчи сообщений — `getMessages(chatId, minId, limit, { reverse: true })`,
курсор растёт между батчами (тот же приём, что Decision 4 у `monitor-v5`).**
Проверено по исходникам GramJS (`node_modules/telegram/client/messages.js`):
без `reverse` пагинация идёт через `offsetId`, который `service.getMessages`
не прокидывает — значит несколько вызовов подряд с одним и тем же `minId=0`
возвращали бы один и тот же срез новых сообщений (риск из первоначального
Open Question подтвердился). С `reverse: true` `minId` сам становится
курсором (сообщения идут от старых к новым, тот же режим, что уже
задействован в `monitor-v5-human-pacing-batching` Decision 4). Поэтому:
`cursor = 0` в начале; на каждой из 1–3 итераций — `getMessages(chatId,
cursor, random(7,15), { reverse: true })`, затем `cursor = max(id батча)`.
Цель здесь — не как в `monitor-v5` (реально дочитать непрочитанный хвост), а
только оставить правдоподобный, не повторяющийся след трафика перед выходом;
`markAsRead` вызывается на `maxId` каждого батча по той же причине
правдоподобности (непрочитанное убывает).

**5. Пометка реестра (`markChannelBanned`) — поведение не меняется, вопрос
остаётся открытым (см. Open Questions).**
Спека `leave-banned-channels` уже требует пометки `discovered_channels.banned_at`
безусловно после успешного выхода (best-effort по резолву username). Это
поведение переносится как есть. То, что `should_leave` — не факт бана,
а решение оператора о выходе, и пометка `banned_at` для него может быть
семантически неверной, — не решается в этом change.

**6. Новые константы — в `src/core/config.ts`, по конвенции `V5_*`
(`<ПРЕФИКС>_<ИМЯ>_MIN/MAX[_SEC]`).**
```
LEAVE_BANNED_BATCH_LIMIT = 20
LEAVE_BANNED_RESOLVE_DELAY_MIN_SEC = 10
LEAVE_BANNED_RESOLVE_DELAY_MAX_SEC = 20
LEAVE_BANNED_CHANNEL_DELAY_MIN_SEC = 2
LEAVE_BANNED_CHANNEL_DELAY_MAX_SEC = 7
LEAVE_BANNED_READ_GATE_PROBABILITY = 0.5
LEAVE_BANNED_READ_BATCHES_MIN = 1
LEAVE_BANNED_READ_BATCHES_MAX = 3
LEAVE_BANNED_MSG_BATCH_MIN = 7
LEAVE_BANNED_MSG_BATCH_MAX = 15
LEAVE_BANNED_MSG_BATCH_DELAY_MIN_SEC = 3
LEAVE_BANNED_MSG_BATCH_DELAY_MAX_SEC = 7
```
Префикс `LEAVE_BANNED_`, не переиспользуем `V5_*` — разные скиллы, разные
диапазоны (обсуждалось и отклонено в explore: единый словарь пацинга не
запрошен, числа у leave-banned свои).

## Risks / Trade-offs

- [Risk] Без `processing`-claim (Decision 3) параллельный прогон
  `leave-banned` для одного агента (ручной триггер поверх обычного тика)
  может дважды взять один и тот же `chatId` в батч → Mitigation: тот же
  принятый риск, что и у `monitor-v5`/`join-queue` до его `processing`-модели;
  `leaveChannel` идемпотентен на стороне Telegram (повторный `LeaveChannel`
  для уже покинутого канала — не ошибка, ошибка ловится и логируется).
- [Risk] Период 3ч вместо раз в сутки увеличивает частоту повторных попыток
  для канала, который систематически не даёт `leaveChannel` выполниться
  (нет разделения временная/постоянная причина отказа, в отличие от
  `join_queue`) — в 8 раз чаще, чем раньше. Явно обсуждалось с пользователем
  и оставлено вне скоупа этого change (см. proposal.md); зафиксировано здесь
  как принятый риск, не тихо забытый.
- [Risk] Decision 4 (батчи без курсора) может читать один и тот же срез
  сообщений повторно — эффект на правдоподобность (три идентичных запроса
  подряд не выглядят как «человек читает») слабее, чем цель пацинга, но не
  нулевой → Mitigation: задача на проверку по документации GramJS перед
  реализацией (tasks.md).
- [Trade-off] Общая длительность обработки одного канала растёт (было —
  доли секунды, станет — до ~20-40с на канал, больше при сработавшем
  гейте чтения) → при батче 20 каналов прогон может занимать до ~15 минут
  в худшем случае (все 20 читают батчи) — заметно меньше `TimeoutStartSec=3600`
  у `tg-agent@.service`, отдельной проверки таймаута юнита не требуется (в
  отличие от `monitor-v5-human-pacing-batching`, где рост длительности был
  более значительным).

## Migration Plan

1. Аддитивная миграция `ChannelStatus`: добавление значения `"should_leave"`
   в тип — не требует изменения схемы БД (`status` уже `TEXT`).
2. Удаление таблицы `banned_channels`: не мигрировать существующие строки —
   агенты, у которых на момент деплоя есть незавершённые строки в
   `banned_channels`, потеряют их из вида. Проверить перед деплоем: если на
   проде есть накопленная очередь, либо дождаться её опустошения текущей
   версией скилла, либо явным разовым проходом продублировать оставшиеся
   `chatId` в `channels.status='banned'` (там, где статус почему-то не
   совпадает) — решение по необходимости такого прохода зависит от
   фактического состояния прод-БД на момент реализации.
3. `src/core/db/tasks.ts`: перенести `"leave-banned"` из
   `DEFAULT_CALENDAR_SCHEDULE` в `DEFAULT_PERIODIC_SCHEDULE` (`periodMinutes:
   180`). Существующие агенты с прежним дефолтом не подхватят автоматически
   (`computeDefaultSchedule` считается только при upsert без явного
   `schedule`) — нужен разовый backfill, по аналогии с уже существующим
   `src/scripts/backfill-schedule-defaults.ts`.
4. Задеплоить код скилла + конфиг константы.
5. Прогнать backfill-скрипт по всем агентам.
6. Убрать вызовы `enqueueBannedChannel` из `monitor-v2.ts`/`post-comment-send.ts`
   — можно одним деплоем с п.4, порядок между ними не важен (оба источника
   пишут независимо, `markChannelStatus` уже происходит в тех же местах).

Откат: вернуть предыдущую версию `leave-banned-channels.ts`/`channels.ts`/
`tasks.ts` (git revert). `banned_channels` к моменту отката уже не пишется —
если откат происходит не сразу, накопившиеся за это время `status='banned'`/
`'should_leave'` каналы не будут отражены в пустой `banned_channels` до
следующего `CHAT_WRITE_FORBIDDEN` по этому каналу. Разовое ручное
дозаполнение `banned_channels` из `channels.status='banned'` — при
необходимости, вне этого плана.

## Open Questions

- Пометка реестра (`markChannelBanned`) — должна ли выполняться только для
  `status='banned'`, а не для `'should_leave'` (не являющегося фактическим
  баном)? Поднято в explore, не решено пользователем — оставлено как есть
  (безусловно) до отдельного решения.
- Migration Plan п.2: нужен ли разовый проход синхронизации оставшихся строк
  `banned_channels` в `channels.status` перед удалением таблицы — зависит от
  фактического состояния прод-БД, не оценивалось в этом change.

~~Decision 4: курсор/порядок для батчей `getMessages`~~ — решено в ходе
реализации, см. Decision 4 (проверено по исходникам GramJS, `reverse: true` +
растущий `minId`-курсор).
