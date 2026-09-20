# История операций с каналами — архитектура

> **О чём документ.** HOW: как реализуется централизованный append-only журнал
> операций над каналами. Источник требований (WHAT) —
> [requirements-v1.md](requirements-v1.md) (R1..R20, US-1..US-7, AC-1..AC-12);
> правила и ограничения оттуда сюда не дублируются, только ссылки на R-*.
>
> **Статус.** Развилки закрыты заказчиком (см. §0). Проектирование, до кода.
>
> **Образцы структуры:** `docs/design/channel-distribution/architecture.md`,
> `docs/design/funnel-tracking/architecture-v2.md`.

---

## 0. Зафиксированные решения

Три развилки, вынесенные требованиями на уровень архитектуры, закрыты так:

1. **Детект перехода статуса — при записи** (не на чтении). Точка-писатель в
   одной транзакции над пер-агентной `channels.db` читает текущий статус,
   сравнивает с новым и, если это настоящий переход из белого списка R8,
   фиксирует операцию в журнал. Этим же закрываются R9 (дедуп: повтор `banned`
   поверх `banned` — не переход, не пишем) и R10 (счёт «нового бана»).
2. **Владение (`assigned`) ведём по `chatId` через мост вступления.** Событие
   рождается в реестре (ключ — `canonical_link`), где `chatId` ещё неизвестен;
   `chatId` появляется на шаге вступления (`upsertChannelIdentityFromJoin`, где
   известны и ссылка, и `chatId`). `assigned`-операции после первого join канала
   получают `chatId`; самое первое назначение до любого join несёт только ссылку.
   Истинно приватных каналов (`t.me/+hash`) в рабочем наборе нет — «приватного
   пробела» не существует (см. §7).
3. **`should_leave` в v1 не журналируется** (нет кодовой точки записи —
   выставляется оператором вручную, минуя модуль). `leaved_manual` (выход по
   решению оператора) журналируется штатно через `setLeftChannelStatus`.

---

## 1. Контекст и связь с кодом

Журнал — новый **платформенный** артефакт; он не заменяет и не дублирует
пер-агентный `channels.status` (тот остаётся источником истины о текущем
состоянии канала). Журнал лишь наблюдает переходы и события владения/вступления.

### 1.1 Точки-писатели, которые надо инструментировать

| Точка | Файл | Что фиксирует | Контекст |
|---|---|---|---|
| `markChannelStatus` | `core/db/channels.ts:504` | переход в `banned`/`suspend` (прочие статусы отфильтрованы белым списком) | пер-агентный |
| `setLeftChannelStatus` | `core/db/channels.ts:1462` | переход в `leaved_from_banned`/`leaved_manual` | пер-агентный |
| `expireChannelStatuses` | `core/db/channels.ts:591` | снятие `suspend` по таймеру (переработка — §6.2) | пер-агентный (диспетчер) |
| `upsertChannelIdentityFromJoin` | `core/db/channels.ts:922` | `joined` + наполнение моста ссылка↔`chatId` | пер-агентный |
| `assignChannel` | `core/db/discovery.ts:220` | `assigned` при первичном назначении (old пуст) | admin |
| `forceAssignChannel` | `core/db/discovery.ts:336` | `assigned` при переназначении (old читать до перезаписи) | admin |

Все мониторы (`monitor-v2..v5`) банят канал либо прямым `markChannelStatus`
(`monitor-v2.ts:291`), либо через `handlePostCommentSendError`
(`core/post-comment-send.ts:83`, вызывается из `monitor-v3/4/5` и review-listener)
→ тот же `markChannelStatus`. Значит **инструментировать надо
`markChannelStatus`, а не каждый монитор** — сам монитор не трогается (§10).

### 1.2 Прецеденты, на которые опирается дизайн

- **Межконтекстная запись «пер-агентный процесс → admin-workspace БД» уже в
  проде:** `monitor-v2.ts:295` вызывает `upsertRestriction(FUNNEL_ADMIN_AGENT_ID,
  …)` → `agentRestrictionsDbPath`. Журнал пишется этим же приёмом (§9).
- **Отдельная платформенная БД в admin-workspace по константе
  `FUNNEL_ADMIN_AGENT_ID`:** `discovery.db`, `channel-distribution.db`,
  `agent-restrictions.db`, `private-invites.db` (`core/config.ts:158..218`).
- **Идемпотентное создание схемы с guard-множеством:** `ensureSchema` +
  `initializedDbs: Set` в `discovery.ts:16-91`.
- **Append-only журнал в SQLite:** `channel_visits` (`channels.ts:1242`).
- **JSON-поле произвольного состава:** `discovered_channels.metrics_json`
  (`discovery.ts:80`).
- **Best-effort запись, не роняющая основной поток:** `saveChatAccessHash`
  (`channels.ts:808`).

---

## 2. Обзор решения

```
пер-агентный процесс (monitor / leave / join / dispatcher)
        │  status-переход или joined
        ▼
  точка-писатель в channels.ts
        │  (channels.db: SELECT old → UPDATE — атомарно, источник истины статуса)
        ▼
  core/db/channel-operations.ts  ── FUNNEL_ADMIN_AGENT_ID ──►  channel-operations.db
        │  classify(old,new) по белому списку R8                 (admin-workspace, WAL)
        │  best-effort append (сбой не роняет основной поток)

admin-процесс (discovery / distribution / rotation)
        │  смена владельца в реестре
        ▼
  assignChannel / forceAssignChannel (discovery.ts)
        │  (discovery.db: read old owner → upsert) + append assigned
        ▼
  channel-operations.db  (chatId резолвится через мост ссылка↔chatId)
```

Единственный новый модуль — `core/db/channel-operations.ts`: владелец схемы
журнала, белого списка переходов (R8) и всех операций записи/чтения. Все
точки-писатели вызывают его функции; больше нигде логики журнала нет (риск R-1).

---

## 3. Физическое хранилище

**Выделенный файл `channel-operations.db`** в workspace админ-агента. Новый путь
в `core/config.ts` по образцу соседей:

```ts
export function channelOperationsDbPath(adminAgentId: string): string {
    return path.join(workspaceDir(adminAgentId), "channel-operations.db");
}
```

**Почему отдельный файл, а не таблицы в `discovery.db`:**
- `discovery.ts:56-73` при миграциях **полностью пересобирает** таблицу
  `discovered_channels` (`CREATE new → INSERT SELECT → DROP → RENAME`). Журнал в
  том же файле рисковал бы попасть под чужие пересборки/блокировки. Журнал —
  независимая ответственность со своим жизненным циклом и (в будущем) своим
  сроком хранения.
- **Профиль записи принципиально иной:** в `discovery.db`/`agent-restrictions.db`
  пишут в основном одиночные admin-задачи, а в журнал одновременно пишут
  **мониторы всех агентов** на каждом тике. Отдельный файл изолирует эту
  нагрузку.

**Конкурентная запись (риск R-5).** При создании схемы:
- `PRAGMA journal_mode = WAL;` — параллельные читатели не блокируют писателя и
  наоборот;
- `PRAGMA busy_timeout = 5000;` — писатель ждёт освобождения блокировки вместо
  немедленного `SQLITE_BUSY` (несколько агентских процессов пишут в один файл).

Соединения короткоживущие (open→операция→close), как во всех модулях `core/db/`.

---

## 4. Схема таблиц

```sql
-- Общая часть операции (R3) + реквизиты key:value как JSON (R5).
CREATE TABLE IF NOT EXISTS operations (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,   -- уникальный id (R3)
    ts      INTEGER NOT NULL,                    -- unix-секунды (R3)
    type    TEXT    NOT NULL,                     -- 'status_change'|'assigned'|'joined' (R3)
    chat_id TEXT,                                 -- marked peer id (R4); NULL только у
                                                  -- 'assigned' до первого join (§7)
    source  TEXT    NOT NULL,                     -- 'operator'|'monitor'|'timer'|'module' (R6)
    attrs   TEXT    NOT NULL DEFAULT '{}'         -- JSON: реквизиты, зависят от типа (R5,R7,R11,R12)
);
CREATE INDEX IF NOT EXISTS idx_ops_chat_type_ts ON operations(chat_id, type, ts);  -- R16, R17
CREATE INDEX IF NOT EXISTS idx_ops_type_ts      ON operations(type, ts);           -- R18

-- Мост «ссылка ↔ chatId» (§7): наполняется при вступлении, связывает
-- реестровые assigned (по ссылке) с журналом (по chatId) для R17.
CREATE TABLE IF NOT EXISTS channel_identity (
    canonical_link TEXT PRIMARY KEY,
    chat_id        TEXT NOT NULL
);

-- Граница доступности данных (R19): момент старта сбора.
CREATE TABLE IF NOT EXISTS journal_meta (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    started_at INTEGER NOT NULL
);
```

Состав `attrs` по типам (валидируется на записи, не схемой):

| type | attrs |
|---|---|
| `status_change` | `oldAgentId`, `newAgentId`, `oldStatus`, `newStatus` (R7) |
| `assigned` | `oldAgentId` (пусто при первичном), `newAgentId`, `canonicalLink` (R11) |
| `joined` | `agentId` (R12) |

Для `status_change` канал не меняет владельца, поэтому `oldAgentId == newAgentId ==`
агент-владелец в момент перехода; поле `newAgentId` — то, по которому R16/R18
относят бан к агенту (пара хранится для соответствия R7 и единообразия формы).
Активное состояние (снятие `suspend`) представляется `newStatus = null`.

### 4.1 Хранение реквизитов: JSON-поле vs отдельная таблица

| Критерий | JSON-поле `attrs` (выбрано) | EAV-таблица `operation_attrs(op_id,key,value)` |
|---|---|---|
| Расширяемость R5/AC-11 | новый тип = новые ключи, схема не меняется, старые записи валидны | то же, но запись типа рвётся на N строк |
| Запрос R16/R18 (фильтр по `newStatus` **и** `newAgentId`) | один `json_extract` в `WHERE`, без join | самосоединение таблицы реквизитов (pivot) — сложнее |
| Соответствие R3 «список key:value» | JSON-объект и есть список key:value | буквальный key:value |
| Индексируемость | по `attrs` без индекса; ключевые фильтры сужены индексом `(chat_id,type,ts)` | можно индексировать `(key,value)`, но нужен pivot |

**Выбор — JSON-поле** (прецедент `metrics_json`): проще и запросы R16/17/18
остаются одно-табличными. Объём мал (баны — редкие события; на канал за период
единицы), поэтому `json_extract` после сужения индексом `(chat_id,type,ts)`
дёшев. Если объём вырастет — можно **аддитивно** добавить generated-колонки над
`json_extract('$.newStatus')`/`'$.newAgentId'` и индекс на них, не меняя записи
(R5/AC-11). Пока не нужно — не добавляем (простота).

---

## 5. Единый примитив записи и белый список R8

Модуль `core/db/channel-operations.ts`. Публичные функции:

- `ensureChannelOperationsSchema(adminAgentId)` — идемпотентно (guard-`Set`),
  создаёт схему, включает WAL/`busy_timeout`, при первом создании пишет
  `journal_meta.started_at` (R19).
- `classifyStatusTransition(oldStatus, newStatus): TransitionKind | null` —
  **единственное место** белого списка R8.
- `recordStatusChange({adminAgentId, chatId, agentId, oldStatus, newStatus, source})`
  — применяет `classifyStatusTransition`; `null` → no-op; иначе append.
- `recordAssigned({adminAgentId, canonicalLink, oldAgentId, newAgentId, source})`
  — резолвит `chatId` из `channel_identity`, append.
- `recordJoined({adminAgentId, chatId, agentId, canonicalLink, source})` —
  append `joined` **и** upsert `channel_identity` (мост, §7).

Белый список (риск R-1, AC-9). Журналируются строго переходы R8:

```
classifyStatusTransition(old, new):
  new == 'banned'            && old != 'banned'   → 'ban'            // вход в banned (R10)
  new == 'suspend'           && old != 'suspend'  → 'suspend'        // вход в suspend
  old == 'suspend'           && new активный      → 'suspend_lift'   // снятие suspend
  new == 'leaved_from_banned'                     → 'leave_banned'
  new == 'leaved_manual'                          → 'leave_manual'
  иначе                                           → null             // не журналируем
```

`null` для всего прочего: `format_error`, `only_comment`, `sleep`, `not_found`,
`should_leave`, а также `banned→активный` при повторном вступлении (это не событие
R8; факт «выхода из бана» для R10 отражён тем, что `channels.status` уже стал
активным — §5.1).

### 5.1 Детект перехода, дедуп (R9) и «новый бан» (R10)

Точки-писатели статуса меняются так: **в существующей транзакции над
`channels.db`** сначала `SELECT status` строки (старое значение), затем `UPDATE`.
Старый статус захватывается и после коммита передаётся в `recordStatusChange`:

```
BEGIN (channels.db)
  old := SELECT status FROM channels WHERE chatId = ?
  UPDATE channels SET status = new, ... WHERE chatId = ?
COMMIT
recordStatusChange(old → new, ...)   // best-effort, §9
```

- **R9/AC-7 (дедуп разных точек кода).** Второй `banned`, пришедший из другой
  точки, видит `old == 'banned'` → `classifyStatusTransition` вернёт `null` →
  записи нет. Один фактический переход = одна учётная единица.
- **R10/AC-8 (новый бан).** `ban` фиксируется только при `old != 'banned'`. После
  реального выхода/сброса/ротации+вступления `channels.status` становится
  активным (или терминальным), поэтому следующий `banned` снова засчитывается.
  Правило опирается на живой `channels.status` — отдельного состояния в журнале
  не требуется.

**Атомарность через границу файлов.** `channels.db` (пер-агентная) и
`channel-operations.db` (admin) — разные файлы; в режиме WAL SQLite не гарантирует
атомарный коммит через несколько БД, поэтому единую кросс-файловую транзакцию не
используем. Разделяем ответственность: атомарен **`SELECT old + UPDATE` в
`channels.db`** — это источник истины поведения и гарантия недвоения (гейт
принимает решение по согласованному old). Append в журнал — отдельная
best-effort запись (§9): её потеря даёт **недоучёт** (пропущенная запись, что
согласуется с R19 «нет ретроспективной гарантии»), но **никогда не двойной счёт**
и не искажение статуса.

---

## 6. Точки-писатели и источники

Источник (R6/AC-10) — фиксированный перечень `operator | monitor | timer |
module`, **прокидывается параметром** на каждой точке (из функции-писателя не
выводится). Раскладка:

| Точка-писатель | Тип операции | source |
|---|---|---|
| `markChannelStatus` из `monitor-v2` и `post-comment-send` (мониторный контекст) | status_change (`ban`/`suspend`) | `monitor` |
| `markChannelStatus` из `post-comment-send` в review-listener | status_change | `module` |
| `expireChannelStatuses` (диспетчер, снятие suspend) | status_change (`suspend_lift`) | `timer` |
| `setLeftChannelStatus` (skill `leave-banned-channels`) | status_change (`leave_banned`/`leave_manual`) | `module` |
| `upsertChannelIdentityFromJoin` (skill `join-queue`) | joined | `module` |
| `forceAssignChannel` из `channel-rotation` | assigned | `module` |
| `assignChannel`/`forceAssignChannel` из discovery/distribution (авто) | assigned | `module` |
| `forceAssignChannel` из ops-скриптов оператора (`redistribute-channels`, `distribute-pool`) | assigned | `operator` |

`source` добавляется как параметр с дефолтом `monitor` у `markChannelStatus`,
чтобы существующие вызовы монитора компилировались без правок (§10).

### 6.1 `assigned`: чтение прежнего владельца (R11)

- `assignChannel` (`discovery.ts:220`) присваивает только из `NULL` ⇒
  `oldAgentId` пуст — ровно «первичное назначение» (R11/AC-4), читать нечего.
- `forceAssignChannel` (`discovery.ts:336`) перезаписывает владельца. Меняем так,
  чтобы **в той же транзакции `discovery.db`** прочитать прежний `assigned_agent`
  **до** `INSERT … ON CONFLICT … DO UPDATE`, и передать его как `oldAgentId` в
  `recordAssigned`. Обе функции живут в admin-контексте, где журнальная БД в том
  же workspace, — межконтекстного мостика тут не нужно.

### 6.2 Снятие `suspend` по таймеру (риск R-2)

`expireChannelStatuses` (`channels.ts:591`) сейчас **пакетным** `UPDATE` гасит и
`suspend`, и `sleep`, не зная пер-канальный старый статус. Переработка на
пообъектную обработку без изменения внешнего поведения:

```
BEGIN (channels.db)
  rows := SELECT chatId, status FROM channels
          WHERE statusDurationSeconds IS NOT NULL AND now >= statusUpdatedAt + statusDurationSeconds
  UPDATE ... (сброс истёкших — как сейчас; sleep тоже гасится)
COMMIT
for r in rows where r.status == 'suspend':
    recordStatusChange(old='suspend', new=null, source='timer')   // 'suspend_lift'
```

`sleep`-строки по-прежнему гасятся, но **не** журналируются (не в R8;
`classifyStatusTransition` их отсеет, даже если случайно передать). Пакетный сброс
статусов сохраняется — добавляется только чтение `status` для журнала.

---

## 7. `assigned` через мост вступления (chatId для владения)

**Проблема.** `assigned` рождается в реестре по `canonical_link`; `chatId` там
неизвестен и до первого вступления не существует нигде в системе (вступление
резолвит `chatId` = `utils.getPeerId(discussionChat)`, `service.ts:1464`).

**Мост.** Единственная точка, где `canonical_link` и `chatId` известны вместе, —
успешное вступление (`join-queue.ts:71` → `upsertChannelIdentityFromJoin`).
`identity.channelUsername` = username родительского broadcast-канала, а
`canonical_link` реестра = `normalizeChannelLink(channelUsername)`. Поэтому
`recordJoined` при каждом вступлении **upsert-ит** `channel_identity(canonical_link,
chat_id)` — это персистентная карта ссылка↔`chatId`.

**Как `assigned` получает `chatId`.** `recordAssigned` резолвит `chatId` из
`channel_identity` по `canonical_link`:
- канал уже вступался (карта заполнена) — `assigned.chat_id` заполняется; сюда
  попадают все переназначения (ротация: чтобы уехать, канал был join-нут агентом
  A, значит `chatId` в карте есть);
- **первичное назначение до любого join** — `chat_id = NULL`, но
  `attrs.canonicalLink` хранится всегда.

**R17 при `chat_id = NULL`.** Тайм-линия по `chatId` мостит такие записи через
карту (§8, запрос R17): как только канал хоть раз вступлён, `channel_identity`
связывает его `canonical_link` с `chatId`, и первичный `assigned` попадает в
тайм-линию ретроспективно. Все реальные каналы рабочего набора рано или поздно
вступаются, поэтому «приватного пробела» нет (краевой случай требований «Тайм-линия
владения без собственного username»).

---

## 8. Запросы к данным (R16–R19)

Все запросы — только чтение журнала (v1 без UI, R20: разовые выгрузки аналитика).

**R16/AC-1/AC-3 — баны канала у агента:**
```sql
SELECT ts FROM operations
WHERE chat_id = :chatId AND type = 'status_change'
  AND json_extract(attrs,'$.newStatus') = 'banned'
  AND json_extract(attrs,'$.newAgentId') = :agentId
ORDER BY ts;
```
Число = `COUNT`, моменты = `ts`. Дедуп/новизна уже обеспечены на записи (§5.1),
read-time дедуп не нужен (AC-7/AC-8). `chatId` покрывает и каналы после ротации
(AC-2: разные владельцы отфильтровываются `newAgentId`), и каналы без
собственного username (AC-3).

**R17/AC-4 — тайм-линия владения (мостит `chat_id = NULL`):**
```sql
SELECT ts,
       json_extract(attrs,'$.oldAgentId') AS old_agent,
       json_extract(attrs,'$.newAgentId') AS new_agent
FROM operations
WHERE type = 'assigned'
  AND ( chat_id = :chatId
        OR json_extract(attrs,'$.canonicalLink') IN
             (SELECT canonical_link FROM channel_identity WHERE chat_id = :chatId) )
ORDER BY ts;
```

**R18/AC-5 — агрегат банов по агенту за период:**
```sql
SELECT json_extract(attrs,'$.newAgentId') AS agent, COUNT(*) AS bans
FROM operations
WHERE type = 'status_change'
  AND json_extract(attrs,'$.newStatus') = 'banned'
  AND ts >= :startSec AND ts < :endSec
GROUP BY agent;
```

**R19/AC-12 — граница доступности данных.** Выгрузка сравнивает начало
запрошенного периода с `journal_meta.started_at`; если период начинается раньше —
явно помечает границу (данных до `started_at` нет; отсутствие записей ≠ ноль
банов). Логика — в слое выгрузки, не в схеме.

---

## 9. Межконтекстная запись и изоляция сбоев

**Межконтекстная запись.** Пер-агентные точки-писатели (`channels.ts`) импортируют
`FUNNEL_ADMIN_AGENT_ID` и вызывают функции `channel-operations.ts`, которые
открывают `channelOperationsDbPath(FUNNEL_ADMIN_AGENT_ID)`. Это тот же приём, что
`monitor-v2.ts:295 → upsertRestriction(FUNNEL_ADMIN_AGENT_ID, …)` (§1.2). Admin-
точки (`discovery.ts`) уже в admin-контексте — журнальная БД в их же workspace.

**Изоляция сбоев.** Любой вызов `recordStatusChange/recordAssigned/recordJoined`
обёрнут в `try/catch` с логированием и проглатыванием (прецедент
`saveChatAccessHash`). Журнал — наблюдаемость, а не поведение: его сбой не должен
ронять обработку канала, вступление или простановку статуса. Последствие потери
append — недоучёт (§5.1), не искажение.

---

## 10. Влияние на существующий код (минимизация)

- **Мониторы `v2..v5` — не трогаются.** Инструментирование внутри
  `markChannelStatus`; мониторы вызывают её (прямо или через
  `handlePostCommentSendError`) без изменений сигнатур на их стороне.
- **`markChannelStatus`/`setLeftChannelStatus`/`expireChannelStatuses`** —
  получают чтение старого статуса и `best-effort` append; внешнее поведение
  (что и когда пишется в `channels.status`) сохраняется. К `markChannelStatus`
  добавляется опциональный `source` с дефолтом `monitor` — существующие вызовы
  компилируются без правок.
- **`leave-banned-channels`** — не трогается; журналирование внутри
  `setLeftChannelStatus`.
- **`upsertChannelIdentityFromJoin`** — добавляется append `joined` + upsert
  моста; существующий upsert идентичности/сброс статуса сохраняется.
- **`assignChannel`/`forceAssignChannel`** — `forceAssignChannel` читает прежнего
  владельца в своей транзакции; обе добавляют append `assigned`. Поведение
  реестра не меняется.
- **`join-queue`, `channel-rotation`, ops-скрипты** — вызовы примитивов реестра
  те же; отличается только то, что примитивы теперь дополнительно журналируют.

---

## 11. Обратная совместимость, миграции, идемпотентность

- **Новый файл БД, чистая схема** — легаси-миграций нет. Существующие БД
  (`channels.db`, `discovery.db`) структурно не меняются.
- **`ensureChannelOperationsSchema`** идемпотентна (guard-`Set` + `CREATE TABLE IF
  NOT EXISTS`), безопасна на каждом прогоне; вызывается лениво из функций записи
  (как `ensureTable` в `join-queue.ts`) — первый писатель создаёт БД.
- **Аддитивность (R5/AC-11).** Новый тип операции = новые ключи в `attrs`, без
  ALTER и без влияния на прошлые записи и запросы существующих типов. Будущая
  индексация через generated-колонки — тоже аддитивна.
- **Обратимость.** Журнал append-only и изолирован в отдельном файле; отказ от
  фичи = прекратить запись, данные существующих БД не затронуты. Правки
  `discovery.ts`/`channels.ts` — аддитивные (чтение old + append), откатываются
  снятием вызовов.

---

## 12. Соответствие требованиям

| Требование | Где решено |
|---|---|
| R1 (централизованно) | §3 один файл в admin-workspace |
| R2/AC-6 (append-only) | §4 `operations` только INSERT; §9 без UPDATE/DELETE |
| R3 (общая часть + key:value) | §4 колонки + `attrs` JSON |
| R4/AC-3 (ключ `chatId`) | §4 `chat_id`; §7 мост для `assigned` |
| R5/AC-11 (расширяемость) | §4.1 JSON `attrs`; §11 аддитивность |
| R6/AC-10 (источник) | §6 таксономия и раскладка |
| R7 (реквизиты status_change) | §4 таблица attrs |
| R8/AC-9 (белый список) | §5 `classifyStatusTransition` в одном месте |
| R9/AC-7 (дедуп) | §5.1 гейт `old==new` |
| R10/AC-8 (новый бан) | §5.1 опора на живой `channels.status` |
| R11/AC-4 (`oldAgentId`) | §6.1 чтение прежнего владельца |
| R12 (joined) | §6, §7 `recordJoined` |
| R13/R14/R15 (по событию) | §6 точки-писатели |
| R16/R17/R18 | §8 запросы |
| R19/AC-12 (граница данных) | §4 `journal_meta`, §8 |
| R20 (без UI) | §8 только выгрузки |
| R-1/R-2/R-5 (риски) | §5 белый список / §6.2 / §3 WAL |

---

## Вне рамок

- Фиксация перехода в `should_leave` (нет кодовой точки записи — требования,
  «Вне рамок»).
- UI и регулярные отчёты по журналу (R20).
- Ретеншн/архивация журнала — журнал в отдельном файле это позволяет ввести
  позже без влияния на схему; в v1 не проектируется.
- Кросс-файловая атомарность append↔status через ATTACH — сознательно отклонена
  (§5.1, ограничение WAL); выбран best-effort append.
