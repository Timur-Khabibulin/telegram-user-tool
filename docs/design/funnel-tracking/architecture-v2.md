# Воронка v2: архитектура сбора данных (этапы 1-4)

> **О чём документ.** Как физически собираются и хранятся данные для новых
> этапов воронки 1-4 (каналов у агента / просмотрено / активно / отправлено +
> ошибки). Отвечает на Q2-Q4 из
> [requirements-v2.md §5](./requirements-v2.md#5-сводный-список-открытых-вопросов-архитектору).
>
> **Парные документы:** [funnel-tracking-v2.md](./funnel-tracking-v2.md) — *что*
> считаем (воронка, формулы, формат отчёта, не пересматривается здесь).
> [requirements-v2.md](./requirements-v2.md) — User Stories и AC. *Здесь* —
> только модель хранения и точки записи в пайплайне.
>
> **Граница:** этапы 5-7 не меняются (см. funnel-tracking-v1.md,
> `core/db/funnel.ts`, `core/funnel-collect.ts`) — этот документ их не трогает.

---

## 1. Контекст

Этапы 1-4 не требуют новых вызовов к Telegram — все нужные величины уже
вычисляются в коде на каждой итерации:

- `src/skills/monitor.ts` (цикл по каналам, :113-286) на каждый канал знает
  исход визита (ошибка `get_messages` / пусто / `messages.length` сообщений) и
  исход попытки отправки ответа.
- `src/skills/dm-send.ts` (:91-115) на каждую попытку `sendDm` знает тип ошибки
  (`peer_flood`/`flood_wait`/`privacy_blocked`/`deactivated`/прочее), привязанный
  к `candidate.sourceChatId`.

Проблема не в вычислении, а в том, что эти величины живут только в локальных
переменных рана и не сохраняются. Нужны две новые персистентные модели:

- **Q3** — история визитов монитора в канал (для этапов 2-3).
- **Q4** — журнал ошибок отправки по попытке/каналу (для этапа 4, отдельно от
  `runs`, которая агрегирует на уровне целого прогона скилла).

---

## 2. Решение Q2 — константа `CHANNEL_CHECK_PERIOD_SECONDS`

Выносится в `src/core/config.ts` как единственный источник истины:

```ts
/** Номинальный период обхода канала монитором, секунды (72 часа). Источник
 *  истины для отбора назревших каналов (monitor.ts) и для знаменателя
 *  activityRate (funnel-collect.ts) — единое значение, не дублируется. */
export const CHANNEL_CHECK_PERIOD_SECONDS = 259200;
```

Меняются два места:
- `src/skills/monitor.ts:40` — приватная `PERIOD_SECONDS = 259200` удаляется,
  используется импорт из `config.ts`.
- `src/core/db/channels.ts:26` — `DEFAULT_PERIOD_SECONDS` остаётся как дефолт
  параметра `getChannelsBatch` (БД-слой не должен импортировать константу
  верхнего уровня без необходимости), но его значение перестаёт быть
  самостоятельным источником истины: `monitor.ts` всегда передаёт
  `CHANNEL_CHECK_PERIOD_SECONDS` явным аргументом, дефолт в `channels.ts`
  остаётся только как страховка для прямых вызовов функции вне `monitor.ts`
  (на момент написания таких вызовов нет). При следующем изменении периода
  трогать нужно только `config.ts`.
- `src/core/funnel-collect.ts` (новый код, см. §5) — формула `activityRate`
  использует тот же импорт.

---

## 3. Решение Q3 — история визитов монитора (`channel_visits`)

### 3.1 Выбор: новая append-only таблица в существующей `tg-channels.db`

**Где:** `src/core/db/channels.ts`, та же БД (`channelsDbPath(agentId)`), что и
`channels`/`dm_candidates` — монитор уже открывает её каждый прогон, новое
подключение не нужно.

**Почему append-only, а не поле в `channels`:** `channels.lastProcessedAt` —
это состояние («когда обработан последний раз»), а нужна именно история
(сколько визитов было за день и с каким исходом у каждого) — без истории
нельзя посчитать ни «каналов просмотрено за день» (это COUNT визитов за день,
не текущее состояние), ни медиану `activityRate` (нужно `messagesCount`
каждого визита). Поле перезатиралось бы на каждой итерации монитора и не
давало бы дневного счёта при нескольких визитах в день.

**Почему не отдельный файл БД:** в проекте принцип «одна фича — один файл БД»
(per-agent), но `channel_visits` — не отдельная фича, а история того же
домена, что и `channels` (визит канала). Они всегда читаются/пишутся в одном
цикле монитора; разнесение по файлам добавило бы транзакционные швы без
выигрыша.

### 3.2 Схема

```sql
CREATE TABLE IF NOT EXISTS channel_visits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId        TEXT    NOT NULL,
    visitedAt     INTEGER NOT NULL,   -- unix-сек момента визита
    outcome       TEXT    NOT NULL,   -- 'empty' | 'active' | 'error'
    messagesCount INTEGER NOT NULL DEFAULT 0  -- messages.length; 0 при empty/error
);
CREATE INDEX IF NOT EXISTS idx_channel_visits_chat_time
    ON channel_visits(chatId, visitedAt DESC);
```

`agentId` не нужен как колонка — это уже per-agent файл БД (как `channels`,
`dm_candidates`), дублировать его в каждой строке было бы лишней сущностью
(см. принцип «не плодить лишние поля без причины» — в отличие от `runs`,
которая объединяет несколько файлов БД в одной сводке и поэтому хранит
`agentId` явно).

`outcome`:
- `'error'` — упал `get_messages`, либо статус непрочитанности канала не
  определён после дозапроса страниц диалогов (`getDialogsForBatch`,
  monitor-dialogs-pagination), кроме `FloodAbortError`, который прерывает весь
  прогон и не пишет визит — канал не был обработан.
- `'empty'` — канал встретился в ответе Telegram (`getDialogsForBatch`) с
  `unreadCount === 0`, либо `messages.length === 0`.
- `'active'` — `messages.length > 0`.

Канал, чей статус непрочитанности не подтвердился (`getDialogsForBatch` не
нашёл его ни с каким `unreadCount` — диалоги Telegram закончились или
достигнут потолок страниц), обрабатывается как ошибка (`outcome='error'`), а
не «пусто» — иначе метрика активности искажалась бы каналами, которые
фактически не проверялись (см. design.md change `monitor-dialogs-pagination`).
До этого изменения такой канал ошибочно писался как `outcome='empty'`.

### 3.3 Точка записи

В `src/skills/monitor.ts`, единая функция `recordChannelVisit` из
`core/db/channels.ts`, вызывается в нескольких местах текущего цикла (вместе с
`markChannelProcessed`, не отдельным проходом):

1. Статус канала в `getDialogsForBatch` не определён → `outcome='error'`.
2. Статус найден с `unreadCount === 0` → `outcome='empty'`.
3. Ошибка `get_messages` → `outcome='error'`.
4. `messages.length === 0` → `outcome='empty'`.
5. `messages.length > 0` (ветка с активностью) → `outcome='active'`,
   `messagesCount=messages.length`.

Запись синхронна с `markChannelProcessed` (тот же шаг 5.7/5.1 цикла) — обе
пишутся в одной транзакции по каналу, чтобы не разойтись при сбое между ними.

### 3.4 Расчёт этапов 2-3 (на стороне `funnel-collect.ts`)

Дневное окно — то же `window: DayWindow` (`finishedDayWindow`), что и для
этапов 5-7, без нового понятия границы дня.

```sql
SELECT outcome, messagesCount
FROM channel_visits
WHERE visitedAt >= @startSec AND visitedAt < @endSec
```

- **Этап 2 (просмотрено)** = `COUNT(*)` по всем визитам за день, независимо от
  `outcome` (AC-1.2).
- **Этап 3 (активно)** = `COUNT(*)` где `outcome='active'`.
- **`activityRate`** на канал = `messagesCount / (CHANNEL_CHECK_PERIOD_SECONDS / 3600)`,
  считается только для визитов `outcome='active'` **у которых есть визит того
  же `chatId` ранее, чем текущий** (AC-2.4 — первый визит в канал не участвует
  в медиане). Проверка «есть более ранний визит» — `EXISTS` по той же таблице
  с `visitedAt < текущий.visitedAt`, без отдельного флага «первый визит» в
  схеме (вычислимо из самих данных, лишнее поле не нужно).
- **Медиана по агенту** — вычисляется в коде (TypeScript), не в SQL: выбрать
  `activityRate` всех таких визитов агента за день, отсортировать, взять
  средний элемент(ы). На дневном объёме (десятки-сотни каналов на агента)
  считать в памяти быстрее, чем городить оконные функции SQLite для медианы.

### 3.5 Хранение и рост

Append-only, без TTL в этой версии: на агента — один визит на канал раз в
`CHANNEL_CHECK_PERIOD_SECONDS` (≈72ч), то есть ≤ ~10 строк/канал/месяц.
При сотнях каналов на агента это десятки тысяч строк в год — не проблема для
SQLite. Очистку старых визитов (если понадобится) — отдельная задача, не
блокирует эту реализацию (см. Future Work).

---

## 4. Решение Q4 — журнал ошибок отправки (`send_errors`)

### 4.1 Выбор: новая append-only таблица, отдельная от `runs`

Подтверждено решением пользователя (Q5, requirements-v2.md): не реюзать
`runs`/`runs-summary.ts` — там гранулярность «одна строка ошибки на весь
прогон скилла», а здесь нужна гранулярность «одна строка на попытку
отправки/канал». Это разные факты («прогон monitor упал» vs «в канале X не
получилось отправить ответ из-за flood_wait») — по принципу «один факт — один
дом» это две разные таблицы, не вариации одной.

**Где:** та же `tg-channels.db` (`channelsDbPath`), что и `channel_visits` и
`channels` — по той же причине (один домен, один цикл записи, без межфайловых
транзакций). DM-ошибки физически тоже попадают в эту таблицу, хотя
`dm-send.ts` ничего больше в `tg-channels.db` не пишет напрямую сейчас — это
не новая зависимость по сути: `dm-send.ts` уже импортирует функции из
`core/db/channels.ts` (`getPendingDmCandidates` и др.), значит уже работает с
этим файлом БД.

### 4.2 Схема

```sql
CREATE TABLE IF NOT EXISTS send_errors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId      TEXT    NOT NULL,   -- канал/чат, в котором произошла попытка
    occurredAt  INTEGER NOT NULL,   -- unix-сек момента ошибки
    source      TEXT    NOT NULL,   -- 'monitor' | 'dm_send' — кто пытался отправить
    errorCode   TEXT    NOT NULL    -- 'flood_wait' | 'peer_flood' | 'peer_id_invalid' | ...
);
CREATE INDEX IF NOT EXISTS idx_send_errors_time ON send_errors(occurredAt);
CREATE INDEX IF NOT EXISTS idx_send_errors_chat ON send_errors(chatId, occurredAt);
```

`source` различает группового монитора и DM, не объединяя их в одну
безразличную ошибку — design doc v2 явно не разделяет этап 4 на
группы/DM (в отличие от v1, где `group_replies`/`dms_sent` были раздельными
метриками), но для списка «проблемных каналов» (AC-3.5, нужно название канала)
и для будущей диагностики важно знать, где именно ошибка произошла. Поле
дешёвое (один `TEXT`), не вводит новую сущность — просто атрибут события.

**Название канала** не хранится в `send_errors` (это бы дублировало
`channels.title`, который меняется и так уже синхронизируется в `channels`).
При построении отчёта (AC-3.5) название резолвится JOIN'ом
`send_errors.chatId = channels.chatId` в момент агрегации — «один факт, один
дом», название канала живёт только в `channels`.

`errorCode` — значение тех же строк, что уже использует код
(`'peer_flood'`, `'flood_wait'`, `'privacy_blocked'`, `'deactivated'`,
`'peer_id_invalid'` и т.п. из `dm-send.ts`; `'get_messages_error'` /
`'reply_failed'` — для аналогичных catch-веток `monitor.ts`, см. §4.3).
Никакой новой таксономии воронка не вводит (решение Q5).

**Связь с `project_error_normalization`:** эта инициатива (см. memory
`bussines-system-analytic/project_error_normalization.md`) занимается
сквозной нормализацией текста ошибок для **отчётов диспетчера** (другой
канал вывода, другая гранулярность — уровень прогона, `runs.error`,
`{step,reason,error}`). Когда она введёт детерминированный классификатор
причин (`err.code`/`err.message` → нормализованный код), `errorCode` в
`send_errors` должен начать брать значение из него — но на сегодня
классификатор не готов (статус в memory: «жду ответов заказчика»), поэтому
`send_errors.errorCode` пока заполняется значениями, которые код уже
вычисляет сам (см. §4.3). Это не блокирует текущую задачу: колонка `TEXT`
без enum/CHECK-constraint, смена источника значения в будущем не требует
миграции схемы.

### 4.3 Точки записи

**`src/skills/dm-send.ts`** — после блока `if ("error" in sendResult)`
(:91-115), на каждой ветке кроме `peer_flood`/`flood_wait`-continue без
изменения текущей логики управления (stopReason/floodErrors не трогаются —
это поведенческие правила skill'а, не входят в зону этой задачи):

```ts
recordSendError(agentId, {
    chatId: candidate.sourceChatId,
    source: "dm_send",
    errorCode: sendResult.error, // peer_flood | flood_wait | privacy_blocked | deactivated | ...
});
```

Записывается **на каждый исход ошибки**, включая `peer_flood`/`flood_wait`
(они и сегодня прерывают/пропускают попытку, но сам факт ошибки относится к
этапу 4 и должен попасть в разбивку отчёта AC-3.2/AC-3.5). Записи не влияют на
существующий control flow (`break`/`continue` остаются как есть) — вызов
`recordSendError` вставляется перед ними, не меняя поведение skill'а.

**`src/skills/monitor.ts`** — два существующих catch:

1. `:129-139` (ошибка `get_messages`, ветка кроме `FloodAbortError`) —
   `errorCode: "get_messages_error"`, `source: "monitor"`. Относится к
   категории «канал проблемный» (AC-3.5), наравне с ошибками отправки.
2. `:246-253` (`FloodAbortError` при отправке ответа) и обычные ошибки внутри
   try `:170-245` — **решено (см. §7): не-flood ошибка `sendReply` пропускает
   канал и продолжает прогон**, а не валит его целиком. Вызовы `sendReply`
   (5.4/5.5/5.6) оборачиваются в свой try/catch — по той же схеме, что уже
   есть для `get_messages` (:134-139): `recordSendError` + `markChannelProcessed`
   + `continue` к следующему каналу. `FloodAbortError` — особый случай,
   остаётся как есть (прерывает весь прогон, это поведение `withFloodRetry`,
   не относится к этому решению).

### 4.4 Расчёт этапа 4 и отчёта (`funnel-collect.ts`)

```sql
SELECT errorCode, COUNT(*) AS cnt
FROM send_errors
WHERE occurredAt >= @startSec AND occurredAt < @endSec
GROUP BY errorCode
```

- **Ошибок отправки (AC-3.4, CSV)** = `COUNT(*)` всех строк за день
  (по агенту — это per-agent БД, агрегация по агенту делается на уровне
  `funnel-collect.ts`, как и для `channel_visits`).
- **Разбивка по типу (AC-3.2)** = группировка по `errorCode` за день,
  агрегированная по **всем** агентам (отчёт показывает её один раз, не на
  агента — см. пример в funnel-tracking-v2.md §3: `Ошибки за день:
  flood_wait×9, peer_flood×4, ...` — общая строка, не по агенту).
- **Успешных отправок (AC-3.1, столбец «Отправлено»)** — не из
  `send_errors` (там только ошибки); берётся из существующих источников v1:
  `COUNT(replies.sentAt)` + `COUNT(dm_history.sentAt)` за день — те же
  `countSince(repliesDbPath, ...)` / `countSince(channelsDbPath, "dm_history", ...)`,
  что уже использует `funnel-collect.ts` для `groupReplies`/`dmsSent` (этап 4
  складывает их в одну метрику «отправлено», AC-3.1 формулирует это явно).
- **Проблемные каналы (AC-3.5)** = `GROUP BY chatId, errorCode` за день, JOIN
  с `channels.title` за `chatId` (резолв названия, см. §4.2) и `agentId`
  (известен из контекста — какой файл БД читается).

---

## 5. Сводная модель данных

| Таблица | Файл БД | Назначение | Новая/существующая |
|---|---|---|---|
| `channels` | `tg-channels.db` (per-agent) | Состояние канала, последний визит | Существующая, не меняется |
| `channel_visits` | `tg-channels.db` (per-agent) | История визитов монитора (Q3) | **Новая** |
| `send_errors` | `tg-channels.db` (per-agent) | Журнал ошибок отправки monitor+dm-send (Q4) | **Новая** |
| `replies` | `tg-replies.db` (per-agent) | Ответы в группах (этап 4 «отправлено», без изменений) | Существующая |
| `dm_history` | `tg-channels.db` (per-agent) | DM отправлены (этап 4 «отправлено», без изменений) | Существующая |
| `channel_snapshots`, `daily_stats` | `funnel.db` (admin-агент) | Снапшоты и агрегаты этапов 5-7 | Существующая, не меняется |

`channel_visits` и `send_errors` физически лежат в `tg-channels.db`, не в
`funnel.db`: это данные конкретного агента (как `channels`), а не
платформенный артефакт (как `funnel.db`, который объединяет всех агентов для
отчёта). `funnel-collect.ts` читает их так же, как уже читает `replies`/
`dm_history` — `countSince`-подобными функциями по нескольким per-agent БД, без
записи туда: расчёт этапов 1-4 **не персистится** отдельно (в отличие от
этапов 5-7, где `daily_stats` нужен для пересчёта дельт между прогонами) —
этапы 1-4 не дельты, пересчитываются из первоисточника (`channel_visits`/
`send_errors`/`channels`) при каждом построении отчёта, как уже делается для
`groupReplies`/`dmsSent` в текущем коде. Дополнительная таблица агрегатов для
1-4 не нужна — она дублировала бы то, что и так быстро считается прямым
запросом по дню.

---

## 6. Изоляция ошибок в `collectFunnel` — раздельные try/catch

Сейчас (`core/funnel-collect.ts:112-176`) весь сбор по одному агенту — один
`try`: локальные SQLite-чтения (`countSince` по `replies`/`dm_history`) и
MTProto-вызовы (`getOwnPersonalChannel`, `getPostViews`, `getChannelSubsCount`)
лежат в одном блоке, один `catch` помечает агента целиком `note: "пропущен"`.

**Решено:** чтения `channel_visits`/`send_errors` (этапы 1-4) выделяются в
**отдельный try/catch**, не общий с MTProto-блоком (этапы 5-7). Причина — это
разные источники отказа с разной ценой потери: если упадёт MTProto (сессия,
прокси, флуд-лимит) — этапы 1-4 для этого агента всё равно посчитаются (это
чистый SQLite, без сети); и наоборот, если временно заблокирован
`tg-channels.db` (монитор пишет в него в этот момент) — просмотры/подписчики
агента из MTProto не должны теряться из-за этого. Один общий `catch` на агента
сегодня превращает частичный сбой в полную потерю данных по агенту за день.

```ts
// funnel-collect.ts, для каждого agentId:
try {
    row.channelsTotal     = countChannels(agentId);
    row.channelsVisited   = countVisitsToday(agentId, window);
    row.channelsActive    = countActiveVisitsToday(agentId, window);
    row.activityRateMedian= medianActivityRate(agentId, window);
    row.sendErrors        = countSendErrorsToday(agentId, window);
    row.errorBreakdown     = groupSendErrorsByCode(agentId, window);
} catch (err: any) {
    row.note1to4 = `этапы 1-4 пропущены: ${err.message ?? err}`;
}

try {
    // существующий MTProto-блок (этапы 5-7), без изменений логики
} catch (err: any) {
    row.note5to7 = `этапы 5-7 пропущены: ${err.message ?? err}`;
}
```

Один `AgentFunnelRow.note` (как сейчас) становится двумя независимыми
пометками — частичный отчёт по агенту (где видны 1-4, но не 5-7, или
наоборот) лучше, чем полное молчание по агенту.

---

## 7. Решение: ошибка `sendReply` в группе — пропустить канал, не прерывать прогон

Не-flood ошибка отправки ответа (`sendReply`, шаги 5.4/5.5/5.6) сегодня
пробрасывается (`throw err`, :252) и валит весь прогон `monitor.ts` для всех
оставшихся каналов в батче. **Решено:** при ошибке отправки в одном канале —
перейти к следующему каналу, не останавливать прогон, по аналогии с уже
существующей обработкой `get_messages` (:134-139).

Вызовы `sendReply` в 5.4/5.5/5.6 оборачиваются в свой try/catch (не весь блок
:170-245 — только сама отправка): при ошибке (не `FloodAbortError`) —
`recordSendError` + `markChannelProcessed` + `continue` к следующему каналу.
`FloodAbortError` остаётся особым случаем и прерывает весь прогон, как и
сейчас (это поведение `withFloodRetry`, не затрагивается этим решением — оно
осознанно глобальное: повторный flood — сигнал придержать всего агента, а не
один канал).

---

## 8. Соответствие открытым вопросам

| № | Вопрос | Решение |
|---|---|---|
| Q2 | Константа периода дублируется | `CHANNEL_CHECK_PERIOD_SECONDS` в `core/config.ts`, единственный источник (§2) |
| Q3 | Где хранить `messagesCount` по визиту | Новая таблица `channel_visits` в `tg-channels.db`, append-only (§3) |
| Q4 | Где хранить ошибки отправки по попытке/каналу | Новая таблица `send_errors` в `tg-channels.db`, отдельная от `runs` (§4) |
| — | Изоляция ошибок в `collectFunnel` | Раздельные try/catch на этапы 1-4 и 5-7 (§6) |
| — | Ошибка `sendReply` в monitor.ts | Пропустить канал, продолжить прогон (§7) |

---

## 9. Расположение CSV-вложения

CSV-файл отчёта (`funnel-tracking-v2.md` §3) кладётся туда же, куда уже
кладёт свои CSV channel-content-analysis — `reportsDir(adminAgentId)`
(`core/config.ts`), с именем по той же конвенции (UTC-timestamp в имени,
чтобы прогоны не перезатирали друг друга). Не вводим новый каталог под один
отчёт — воронка просто ещё один потребитель уже существующего
платформенного каталога отчётов.

---

## 10. Подтверждено: `channel_visits` как задел для будущего lag

`channel_visits.visitedAt` хранит полную историю визитов монитора в канал —
этого достаточно, чтобы в будущем посчитать lag (`now - последний
visitedAt`) без изменения схемы, если эта метрика вернётся в скоуп
(funnel-tracking-v2.md явно вынес её за рамки текущей версии). Это не
дополнительная работа сейчас — таблица проектировалась под Q3 независимо от
lag, совпадение источника данных просто отмечено, чтобы не переизобретать
его при следующей версии.

---

## 11. Future Work

- Очистка старых строк `channel_visits`/`send_errors` (TTL), если объём
  станет проблемой — не нужно на текущем масштабе (§3.5).
- Замена `errorCode` в `send_errors` на нормализованный код из
  `project_error_normalization`, когда тот классификатор будет готов (§4.2) —
  без изменения схемы, только источника значения.
- Lag по агенту (§10), если вернётся в скоуп — данные уже собираются.
