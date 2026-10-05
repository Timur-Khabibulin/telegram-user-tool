# Право писать в канал — архитектура

Design-doc (КАК). Источник требований (ЧТО) — [requirements-v1.md](requirements-v1.md).
Диаграмма домена (TL-схема) — [participant-rights-model.puml](participant-rights-model.puml).
Здесь фиксируется техническое решение по факту текущего кода ветки `refactoring-2`.

Модель **проактивная**: препятствия определяются из статусов канала и участника
**перед отправкой**, каждое пишется в журнал операций (ИО), по каждому выполняется
однозначное действие. Прежняя редакция описывала реактивную модель с колонкой
`write_access_reason` — она заменяется. Документ описывает целевое состояние и дельту
от текущего кода. Все развилки согласованы с владельцем (см. §12).

---

## 1. Резюме решения

- **Признак «писать нельзя» больше не хранится отдельной колонкой.** Каждое
  препятствие §3.5 требований отображается на существующий механизм жизненного цикла
  (`status`), очередь вступления или журнал. Гейт отправок/чтения обеспечивается тем,
  что действие уводит канал из выборки `getChannelsBatch` (`banned`/`suspend`).
  Колонки `write_access_reason` / `write_access_until` из модели удаляются (§8).
- **Классификация возвращает действие, а не причину.** Чистая функция
  `classifyWriteAccess(snapshot) → WriteAccessAction` — единственный дом маппинга
  (заменяет `classifyParticipant`/`isPermanentReason`/`classifyDefaultBannedRights`).
- **Проактивная проверка — одна точка** в `monitor-v5`, перед фазой отправок (шаг
  5.3c). Реактивная классификация ошибок отправки (`post-comment-send.ts`) остаётся
  резервом (R16).

Отображение «статус → действие → механизм»:

| Статус | Уровень | Действие | Механизм |
|---|---|---|---|
| `channel.left`, `chat.left` | аккаунт | авторотация | `markChannelStatus('banned')` → leave-banned → `leaved_from_banned` → channel-rotation |
| `chatForbidden`, `channelForbidden`, `CHANNEL_PRIVATE` при чтении | аккаунт | авторотация | то же (§7.1 — единая точка 5.1) |
| `channelParticipantBanned` | аккаунт | авторотация | то же + payload `kicked_by`/`date`/`banned_rights` в ИО |
| `channelParticipantLeft` / `USER_NOT_PARTICIPANT` | аккаунт | авторотация | то же |
| `channel.restricted` | канал | suspend (∞) + не читать | `markChannelStatus('suspend')` без duration + `restriction_reason` в ИО |
| `default_banned_rights.send_messages` (все замьючены) | канал | suspend (∞) | `markChannelStatus('suspend')` без duration |
| `paid` (`ALLOW_PAYMENT_REQUIRED`, реактивно) | канал | suspend (∞) | как выше, из `post-comment-send` (§6) |
| `channel.restriction_reason` | канал | запись события | ИО (`platform`/`reason`/`text`) |
| `channel.slowmode_enabled` | канал | suspend временный | `markChannelStatus('suspend', slowmodeSeconds)` → `expireChannelStatuses` |
| `channel.join_to_send` (не участник) | канал | вступление | `addJoinQueue` |
| `channel.join_request` (не участник) | канал | заявка + авторотация | `JoinChannel` + `markChannelStatus('banned')` |

Все действия уже существуют в коде — способность их **комбинирует и журналирует**,
не вводя новых механизмов исполнения.

---

## 2. Модель классификации

Один чистый модуль (переработанный `src/core/write-access.ts`) — единственный дом
маппинга. Без I/O, тестируется изолированно (`write-access.test.ts` переписывается
под действия).

### 2.1 Вход: нормализованный снимок

```
interface WriteAccessSnapshot {
  discussion: {
    left: boolean;
    restricted: boolean;
    restrictionReason?: RestrictionReason[];       // platform/reason/text
    slowmodeEnabled: boolean;
    joinToSend: boolean;
    joinRequest: boolean;
    defaultBannedSendMessages: boolean;            // все рядовые замьючены (R17)
  };
  broadcast?: { restricted: boolean; restrictionReason?: RestrictionReason[] };
  participant:
    | { kind: "participant"; ctor: "regular" | "self" | "admin" | "creator" | "banned";
        left?: boolean; kickedBy?: number; date?: number;
        bannedSendMessages?: boolean; untilDate?: number }
    | { kind: "not_participant" }        // channelParticipantLeft / USER_NOT_PARTICIPANT
    | { kind: "banned_in_channel" }      // USER_BANNED_IN_CHANNEL (ошибка вызова)
    | { kind: "forbidden" };             // chatForbidden / channelForbidden / CHANNEL_PRIVATE
  slowmodeDefaultSeconds?: number;       // фикс. дефолт temp-suspend (§12.8), без доп. вызова
}
```

Инверсия флагов `ChatBannedRights` учитывается при разборе `banned_rights` и
`default_banned_rights` (R15): `send_messages = true` = «запрещено»; `until_date`
(`0`, < 30 сек, > 366 дней) = «навсегда» (`normalizeUntil`).

### 2.2 Выход: действие

```
type DetectedStatus =
  | "channel_left" | "chat_forbidden" | "channel_forbidden"
  | "participant_banned" | "participant_left"
  | "restricted" | "members_restricted" | "paid"
  | "slowmode" | "join_to_send" | "join_request";

type WriteAccessAction =
  | { kind: "ok" }
  | { kind: "autorotate";   detected: DetectedStatus; journal: WriteAccessEventPayload }
  | { kind: "suspend";      durationSeconds: number | null; detected; journal } // null = бессрочно
  | { kind: "join";         detected; journal }
  | { kind: "join_request"; detected; journal };   // заявка + авторотация

function classifyWriteAccess(s: WriteAccessSnapshot): WriteAccessAction;
```

### 2.3 Порядок разбора (приоритет при одновременных флагах)

Сначала — что блокирует **всех** (уровень канала, авторотация не поможет), затем —
что блокирует **наш аккаунт** (уровень аккаунта, авторотация может помочь):

1. **`restricted`** (broadcast **или** discussion) → `suspend(∞)` (R10). Верхний
   приоритет: канал ограничен Telegram для всех.
2. **`defaultBannedSendMessages`** (все рядовые замьючены) → `suspend(∞)` (R17).
   Тоже уровень канала — смена аккаунта не поможет.
3. **Доступ потерян** (`participant.kind = "forbidden"`; `discussion.left`) →
   `autorotate` (R6, R7).
4. **`participant_banned`** (`kind="banned_in_channel"`; либо `ctor="banned"` с
   `left=true`; либо `bannedSendMessages=true`) → `autorotate`, payload
   `kicked_by`/`date`/`banned_rights` (R8, R4).
   *Нюанс:* `ctor="banned"` без запрета текста (ограничены только медиа) при
   бинарной гранулярности «хотя бы текст» — писать можно; падаем ниже.
5. **Не участник** (`kind="not_participant"` / `channelParticipantLeft`):
   - `discussion.joinRequest` → `join_request` (заявка + авторотация, R14);
   - иначе `discussion.joinToSend` → `join` (вступление, R13);
   - иначе → `autorotate` (R9).
6. **`slowmode_enabled`** (участник, всё выше — нет) → `suspend(slowmodeDefaultSeconds)`
   временный (R12).
7. иначе → `ok`.

`join_to_send`/`join_request` действуют только в ветке «не участник»: у состоящего
аккаунта ценз вступления на право писать не влияет (§12.3 — подтверждено владельцем).
`paid` в проактивный разбор не входит (виден только реактивно, §6).

---

## 3. Точка проактивной проверки в monitor-v5

Одна точка — **шаг 5.3c**, после классификации сообщений (5.3) и до фазы отправок
(5.4–5.6). Уже существует (сейчас зовёт `getSelfParticipant` + `classifyParticipant`);
переводится на снимок + `classifyWriteAccess`.

Проверка выполняется, только если по каналу есть работа на отправку (`hasSendWork`):
нет отправок — нет служебного вызова (R15). Чтение и сбор DM-кандидатов от гейта не
зависят и идут всегда.

### 3.1 Какие вызовы и минимизация трафика (R2, R15)

| Что | Источник | Живость |
|---|---|---|
| Статус участника; флаги группы (`left`, `restricted`, `slowmode`, `join_to_send`, `join_request`, `default_banned_rights`) | `GetParticipant(self)` в группе — участник + `chats[группа]` в том же ответе | **живьём** каждый прогон, 1 вызов |
| Access-флаги **broadcast** (`restricted`, `restriction_reason`) | `GetFullChannel(broadcast)` при join | **кэш при join** |

Живой на прогон — только `GetParticipant` в группе обсуждения. Его ответ несёт и
объект `channel` группы (флаги освежаются бесплатно), и статус участника. Постоянные
флаги broadcast снимаются разово при join и обновляются на полном проходе диалогов
(`monitor-v5-hash-driven-sync`). Число живых вызовов ограничено сверху числом
**реально пишущихся** каналов за прогон (§9). `USER_NOT_PARTICIPANT`/
`USER_BANNED_IN_CHANNEL` приходят ошибкой вызова (нормализуются в `kind`).

### 3.2 Ветка «не участник»

Если `GetParticipant` вернул `not_participant`, флаги `join_to_send`/`join_request`
берутся из **кэша при join** (строка `channels` существует — join когда-то был). При
отсутствии кэша — дефолт `autorotate` (§12.5, подтверждено), без доп. `GetFullChannel`.

### 3.3 Действие внутри прогона

После `classifyWriteAccess`: `ok` → отправки идут; любое препятствие → фаза отправок
пропускается, действие применяется (`status`/join-очередь) + `recordWriteAccessEvent`,
`continue` к следующему каналу (R17 — одна попытка на канал за прогон, обеспечено
существующим потоком monitor-v5).

---

## 4. Действия → существующие механизмы

### 4.1 Авторотация → status='banned' → channel-rotation

```
markChannelStatus(agentId, chatId, 'banned', …)      # precheck / post-comment-send
  → getLeaveQueue (status IN 'banned','should_leave') # leave-banned-channels
  → выход + setLeftChannelStatus('leaved_from_banned')
  → channel-rotation (суточный): 'leaved_from_banned' → другому аккаунту
```

`getChannelsBatch` исключает `banned`/`leaved_from_banned` — гейт наступает
автоматически. Правки в `leave-banned-channels`/`channel-rotation` не требуются.

### 4.2 Suspend → ChannelStatus + таймер

`markChannelStatus(…, 'suspend', log, durationSeconds, description)`:

- **`restricted` / `default_banned_rights` / `paid`** → `durationSeconds = undefined`
  (бессрочно); для `restricted` `description` = сериализованный `restriction_reason`.
  `suspend` исключён из `getChannelsBatch` → «канал не читаем» (R10) достигается тем
  же исключением, без отдельного флага.
- **`slowmode`** → `durationSeconds = slowmodeDefaultSeconds` (фикс. дефолт, §12.8).
  `expireChannelStatuses` (таймерное снятие, существует) снимает статус по истечении;
  снятие журналируется `recordStatusChange` (`source='timer'`).

### 4.3 Вступление → join-очередь

`join_to_send` при неучастии → `addJoinQueue(agentId, [link], log)`. Ссылка — из
`channelUsername`/`chatUsername`. `runJoinQueue` подхватит; при успехе
`upsertChannelIdentityFromJoin` самолечит строку (`status=NULL`, membership='member').
Авторотация/suspend при `join_to_send` не применяются (AC-7).

### 4.4 Заявка → JoinChannel + авторотация

`join_request` при неучастии → прямой `JoinChannel` на группу обсуждения (§12.6)
инициирует заявку (Telegram → `INVITE_REQUEST_SENT`, тег `invite_request_sent`).
Сразу после — `markChannelStatus('banned')` (авторотация, не дожидаясь одобрения,
R14). Одобрят позже — канал уже уйдёт; повторное членство самолечится при join.

### 4.5 Журнал (ИО) — общий для всех действий

Каждое препятствие §3.5 пишется в `channel-operations` (§5).

---

## 5. Журнал операций (ИО)

`channel-operations.ts` — append-only журнал (одна БД в workspace админ-агента,
ключ `chatId`). Записи best-effort (сбой журнала не роняет обработку).

### 5.1 Новый тип события `write_access`

R3/R4 требуют журналировать **каждый** статус §3.5 с полями, в т.ч. `join_to_send`
(не меняет `status`). Существующий `status_change` покрывает лишь переходы `status` и
несёт только `reason: string` — недостаточно. Вводится один новый тип:

```
OperationType += "write_access"

interface WriteAccessEventPayload {
  status: DetectedStatus;
  level: "channel" | "account";
  action: "autorotate" | "suspend" | "suspend_temporary" | "join" | "join_request";
  kickedBy?: string;                     // participant_banned (R4)
  date?: number;                         // participant_banned (R4)
  bannedRights?: { sendMessages: boolean; untilDate: number | null };  // R4, R15
  restrictionReason?: { platform: string; reason: string; text: string }[];  // R4
}

function recordWriteAccessEvent(params: {
  adminAgentId; chatId; agentId; persona?; source: OperationSource;
  payload: WriteAccessEventPayload;
}, log?): void;
```

Событие пишется **на месте обнаружения** (precheck / реактивный резерв) — единообразно
для всех статусов. `status_change` (banned/suspend/suspend_lift) продолжает писаться
существующим `recordStatusChange` из `markChannelStatus` — отдельный факт («один факт —
один дом»): `write_access` = «обнаружено препятствие с деталями», `status_change` =
«статус изменился». Аналитику банов/ротации (`aggregateBansByAgent` и т.п.) не трогаем.

---

## 6. Реактивный резерв (post-comment-send)

`handlePostCommentSendError` (`post-comment-send.ts`) остаётся резервом (R16) для
препятствий, невидимых проактивно. Переработка веток (с записи `write_access_reason`
на действие + `write_access` событие):

- **`chat_write_forbidden` / `user_banned_in_channel`** → `autorotate`:
  `markChannelStatus('banned')` (как сейчас) + `recordWriteAccessEvent`
  (`status=participant_banned`/`channel_forbidden`). Побочные эффекты (`send_errors`,
  триггер «10 банов за сутки») не меняются.
- **`allow_payment_required` (`paid`)** → **`suspend(∞)`** + `write_access` событие
  (`status=paid`, `level=channel`, §12.1 — подтверждено владельцем). Прежний
  `format_error` для `paid` убирается.
- **`chat_send_plain_forbidden` / `chat_send_media_forbidden`** — вне §3.5, поведение
  как сейчас (`format_error`).
- **`slowmode` / `peer_flood` / прочее** — как сейчас (ретрай slowmode, suspend+abort
  на peer_flood).

Дублирование проактива и резерва — только для случаев, которые проактив не успел
увидеть (изменение флагов между прогонами). By design, не регресс.

---

## 7. Согласованность с идущими changes

### 7.1 tg-peer-identity-model (membership / peer_type / dual-write)

- Все действия идут через `markChannelStatus`, где **dual-write membership** встроен
  (`banned`→`membership='banned'`; `suspend` членство не трогает). Второго писателя
  membership способность не создаёт — конфликта нет.
- **`chatForbidden`/`channelForbidden`/`CHANNEL_PRIVATE` при чтении → авторотация**
  (`banned`), а не `not_found` (§12.2 — подтверждено владельцем, R7). Меняется ветка
  monitor-v5 5.1 (единая точка): `CHANNEL_PRIVATE` со свежим хэшем → `markChannelStatus('banned')`.
  Это отличается от `monitor-v5-hash-driven-sync` (там `not_found`) — согласовать при
  реализации: право записи имеет приоритет, ветка объединяется.
- `join_to_send` → join-очередь → `upsertChannelIdentityFromJoin` ставит
  `membership='member'`. Согласовано.

### 7.2 monitor-v5-hash-driven-sync

- Полный проход диалогов (кэш broadcast-флагов) триггерится по устареванию access_hash;
  проактивная проверка **читает** кэш, не форсирует проход, не конфликтует.
- Ветка `CHANNEL_PRIVATE` (5.1) — единая точка изменения по §7.1.

---

## 8. Модель данных — дельта

- **Из использования удаляются** `channels.write_access_reason`/`write_access_until`
  и функции `setWriteAccessReason`/`clearWriteAccessReason` с их вызовами. «Писать
  нельзя» выражается через `status` + журнал. Колонки **оставляются мёртвыми** до
  отдельной чистки (§12.4 — обратимость; дроп необратим).
- **Переиспользуется без изменения схемы:** `status` (`banned`/`suspend`),
  `statusDurationSeconds` (temp-suspend), `status_description` (`restriction_reason`),
  `channel-operations.operations.attrs` (JSON payload).
- **Новое:** `OperationType = "write_access"` + `recordWriteAccessEvent`. Схема
  `operations` не меняется (расширяется JSON `attrs`).

Миграций схемы `channels` способность не добавляет; бэкафилл не нужен (первое
обнаружение самозаполняет действие/журнал).

---

## 9. Стоимость и флуд (R15)

- Живой вызов на прогон — один `GetParticipant` на канал, **только при** `hasSendWork`.
- Broadcast-флаги — из кэша, не перечитываются.
- `slowmodeDefaultSeconds` — фикс. дефолт, без доп. `GetFullChannel` (§12.8).
- Каналы в `banned`/`suspend` исключены из `getChannelsBatch` — повторных вызовов нет.

Верхняя граница живых `GetParticipant` = число пишущихся каналов, не общее число.
Прирост трафика относительно текущего кода — нулевой (текущий precheck уже делает один
`GetParticipant`); новизна — разбор доп. флагов из **того же** ответа.

---

## 10. Диаграмма потока (precheck monitor-v5, шаг 5.3c)

```
   есть отправки? ── нет ─► читаем/копим DM, дальше (без GetParticipant)
        │ да
        ▼
  GetParticipant(self, группа обсуждения)  ◄── peerCache (5.0)
        │  (+ флаги группы из chats; broadcast.restricted из кэша join)
        ▼
  classifyWriteAccess(snapshot)  ──►  WriteAccessAction
        │
        ├─ ok ───────────────────────────────► фаза отправок 5.4–5.6
        ├─ restricted / default_banned / ─► suspend(∞) [+restriction_reason] ─┐
        ├─ slowmode ──────────────────────► suspend(slowmodeDefaultSeconds) ──┤
        ├─ left/forbidden/banned/left ────► banned (авторотация) ─────────────┤─► recordWriteAccessEvent
        ├─ join_to_send ──────────────────► addJoinQueue(link) ───────────────┤
        └─ join_request ──────────────────► JoinChannel(заявка) + banned ─────┘
                                    │
                        markChannelProcessed → continue (R17)
```

Резерв (§6): `handlePostCommentSendError` → тег → `autorotate` / `suspend`(paid) +
`recordWriteAccessEvent`.

---

## 11. Трассировка требований → решение

| Требование | Где |
|---|---|
| R1 (проверять перед отправкой) | §3 (precheck 5.3c) |
| R2 (участник/цензы — группа; access — оба) | §3.1 |
| R3 (каждый статус → событие ИО) | §5 |
| R4 (`kicked_by`/`date`/`banned_rights`; `restriction_reason`) | §5.1 |
| R5 (уровень канала/аккаунта) | §2.3, §1 |
| R6/R7/R8/R9 (account → авторотация) | §2.3, §4.1, §7.1 |
| R10 (restricted → suspend + не читать) | §4.2 |
| R11 (`restriction_reason` в ИО) | §5.1 |
| R12 (slowmode → temp suspend) | §4.2 |
| R13 (join_to_send → вступление) | §4.3 |
| R14 (join_request → заявка + авторотация) | §4.4 |
| R15 (инверсия `banned_rights`, `until_date`) | §2.1 |
| R16 (реактив — резерв) | §6 |
| R17 (`default_banned_rights` → suspend∞) | §2.3 (шаг 2), §4.2 |
| R18 (`paid` → suspend∞, реактивно) | §6 |

---

## 12. Принятые решения (подтверждено владельцем)

1. **`paid`** → `suspend(∞)` + `write_access` событие (§6). Уровень канала,
   авторотация бесполезна; канал не читаем.
2. **`chatForbidden`/`channelForbidden`/`CHANNEL_PRIVATE` при чтении** → авторотация
   (`banned`), не `not_found`. Меняется ветка monitor-v5 5.1 (§7.1).
3. **`join_request` у состоящего аккаунта** → `ok` (ценз вступления влияет только на
   неучастника).
4. **Колонки `write_access_reason`/`write_access_until`** → оставить мёртвыми до
   отдельной чистки (обратимость).
5. **Ветка «не участник» без кэша флагов** → дефолт `autorotate`, без доп.
   `GetFullChannel`.
6. **Инициирование заявки `join_request`** → прямой `JoinChannel` из precheck
   (заявка + авторотация в одном месте).
7. **`default_banned_rights.send_messages` (все замьючены)** → `suspend(∞)`,
   проактивно (R17). Иначе канал бесконечно ротируется вхолостую.
8. **Длительность temp-suspend при slowmode** → фиксированный короткий дефолт
   (`slowmodeDefaultSeconds`), без доп. `GetFullChannel`.

---

## 13. Риски / trade-offs

- **R2 «на обоих» реализуется асимметрично:** discussion — живьём, broadcast — из
  кэша. Строгое «живьём на обоих» удвоило бы `GetFullChannel` — компромисс по R15.
  Риск: broadcast стал `restricted` после join и до полного прохода — ловится с
  задержкой (реактивный резерв подстрахует).
- **slowmode-suspend низкой ценности** при cadence монитора 72ч (slowmode почти
  всегда истёк к следующему прогону). Реализуется фикс. дефолтом; при желании можно
  положиться только на существующий `retryOnFloodWait`.
- **Слияние ветки `CHANNEL_PRIVATE`** (§7.1) — прямое изменение общей точки monitor-v5
  5.1; согласовать с `monitor-v5-hash-driven-sync` при реализации (приоритет — право
  записи → авторотация).
- **Файлы-опоры:** `src/skills/monitor-v5.ts` (precheck 5.3c, ветка 5.1),
  `src/core/write-access.ts` (переписывается), `src/core/post-comment-send.ts` (резерв),
  `src/core/db/channels.ts` (`markChannelStatus`, `expireChannelStatuses`, `getLeaveQueue`),
  `src/core/db/channel-operations.ts` (тип `write_access`), `src/core/db/join-queue.ts`
  (`addJoinQueue`), `src/core/telegram/service.ts` (`getSelfParticipant` под снимок,
  `joinDiscussionGroups`), `src/features/channel-rotation/run.ts` (потребитель
  `leaved_from_banned`, правок не требует).
