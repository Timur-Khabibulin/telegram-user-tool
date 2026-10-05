# Архитектура: Модель хранения идентичности Telegram-сущностей (peer)

> Парный документ к `requirements-v1.md`. Требования (R1–R6, AC-1…AC-5,
> логическая модель) — вход, которому этот документ не противоречит. Здесь —
> техническое решение: физическая схема хранения, имена полей, механизм
> инвалидации `access_hash`, точки записи, миграция текущей `channels.db`.
>
> Скоуп строго по ТЗ: только идентичность peer и членство, достаточные для
> join / read / leave и устойчивости к переавторизации. Вне скоупа (метрики,
> право записи, post-watch, DM-кандидаты, статусные таймеры, анализ контента)
> — существующие колонки не трогаем, только сохраняем их существование.

## 1. Что есть сейчас (источник истины — код)

Файл БД: `~/.openclaw/workspace-<agentId>/tg-channels.db`, таблица `channels`,
одна строка на чат, в котором агент состоит и который мониторит
(`src/core/db/channels.ts`). Путь и per-agent размещение задаёт
`channelsDbPath` (`src/core/config.ts`).

Одна строка `channels` фактически описывает **два разных peer**:

| Колонка (сейчас) | Что реально хранит | Вид id |
|---|---|---|
| `chatId` (PK) | Peer, в котором агент состоит: супергруппа-обсуждение или обычная группа. То, из чего монитор читает и куда пишет. | marked (`-100…` / `-id`) |
| `chatAccessHash` | `access_hash` этого же peer (`chatId`). Заполняется оппортунистически (post-comment-review). | — |
| `chatUsername` | Публичный username самого этого peer. | — |
| `title` | Отображаемое название этого peer. | — |
| `channelId` | Связанный **broadcast-канал** обсуждения — **другая сущность**. | **raw** (`channel.id`, без `-100`) |
| `channelAccessHash` | `access_hash` связанного broadcast-канала. | — |
| `channelUsername` | Публичный username связанного broadcast-канала. | — |
| `channelTitle` | Название связанного broadcast-канала. | — |
| `channelResolved` | Флаг «связь broadcast уже резолвлена» (0 → добрать резолвом). | — |
| `status` | Прикладной статус (`banned`/`suspend`/`not_found`/…). Косвенно несёт членство. | — |

Ключевые факты из кода, на которых стоит вся модель:

- **Нет ни одного таймстампа провенанса** у `chatAccessHash`/`channelAccessHash`.
  После переавторизации сохранённые в БД `access_hash` устаревают, но код не
  умеет это распознать. Горячий путь монитора это скрывает: `peerCache`
  прогревается заново из `getDialogs`/`listGroupChannels` на каждом прогоне
  (`cachePeerForDialog`, `service.ts`). Холодный путь — `seedPeerCache` +
  `getChatAccessHash` (review-listener на свежем соединении без `getDialogs`) —
  берёт `chatAccessHash` из БД **без проверки актуальности**. Это и есть баг,
  который закрывают R2–R4.
- **`peerCache`** (`Map<chatId, Api.TypeInputPeer>` в памяти `TelegramService`)
  — рабочая копия `access_hash` в рантайме. `min`-конструкторы пропускаются
  (неполный `access_hash`). Это уже соответствует решению 5 координатора.
- **Нет колонки типа peer.** Тип сейчас выводится неявно из вида id (префикс
  `-100…` ⇒ канал/супергруппа; `-id` без `-100` ⇒ basic group) и из того,
  `InputPeerChannel` или `InputPeerChat` собрался в `cachePeerForDialog`.
- **Связь discussion → broadcast** резолвится через
  `GetFullChannel(...).fullChat.linkedChatId` (`joinDiscussionGroups`,
  `resolveLinkedBroadcast`) и сохраняется в `channelId`/`channelAccessHash`.
- **`session_authorized_at` сейчас не существует** нигде. `tg-account.json`
  (`AccountConfig`) хранит `sessionString`, но не момент её авторизации.
- **Замена аккаунта** (`banned-account-replacement`): per-account `tg-channels.db`
  заменяемого агента уничтожается вместе со старым каталогом workspace —
  `commitSwap` (`swap.ts:132`) удаляет `.old` после атомарного swap. Новый
  аккаунт стартует с пустой БД каналов и вступает в закреплённые каналы заново.
  Это корректно; подробно — §5.3.

Точки, где создаётся новая `sessionString` (кандидаты на запись
`session_authorized_at`):

| Точка | Файл | Что делает с конфигом |
|---|---|---|
| Реавторизация из tdata | `features/tg-agent-reauth-from-tdata/run.ts` → `writeSessionString` | переписывает только `sessionString` в существующем `tg-account.json` |
| Sweep реавторизации | `features/agent-reauth-sweep/run.ts` | драйвер, вызывает `reauthFromTdata` (покрыт строкой выше) |
| Автогенерация агента | `features/tg-agent-autoregistration/run.ts` → `promoteToWorkspace` | пишет новый `tg-account.json` целиком |
| Провижининг пула | `features/tg-agent-pool-provision/run.ts` → `promoteToPool` | пишет `tg-account.json` пул-аккаунта |
| Замена аккаунта | `features/banned-account-replacement/swap.ts` → `buildIncoming` | берёт `sessionString` из конфига пула (новую не создаёт); `channels.db` в `.incoming` из пула нет, старую уничтожает `commitSwap` (§5.3) |
| Интерактивный логин | `service.ts` `authSignIn` (возвращает строку) | сам на диск не пишет — персистит вызывающая сторона |

## 2. Целевая схема (проектирование с нуля)

Как должно быть по логической модели требований, без оглядки на текущие имена
колонок. Одна сущность — **Peer**, одна строка на peer, ключ — marked id.

### 2.1. Таблица `peer` (концептуальная целевая)

| Поле | Тип | Null | Класс | Назначение |
|---|---|---|---|---|
| `marked_id` | TEXT | нет (PK) | стабильное | Маркированный id (`-100…` для channel/megagroup, `-id` для basic group). Ключ, глобальный, постоянный. (R1) |
| `peer_type` | TEXT | нет | стабильное | `broadcast` \| `megagroup` \| `basic_group`. Определяет, нужен ли `access_hash`. Меняется только при миграции basic→super (R6). |
| `username` | TEXT | да | изменяемое | Публичный username самого peer; NULL — приватный/нет. Обновляется вслед за Telegram. (R1) |
| `title` | TEXT | нет | изменяемое | Отображаемое название. Обновляется вслед за Telegram. |
| `access_hash` | TEXT | да | **auth-session-scoped** | Собственный `access_hash` peer. NULL для `basic_group` (О4) и пока не получен. (R4) |
| `access_hash_updated_at` | INTEGER | да | **auth-session-scoped** | Unix-секунды записи `access_hash` (системные часы процесса). Провенанс для правила валидности. NULL ⇔ `access_hash` NULL. (R2, R3) |
| `linked_broadcast_id` | TEXT | да | стабильное | Marked id связанного broadcast-канала — только для `megagroup`-обсуждения. NULL иначе. Стабильная связь 1:1. (R1) |
| `linked_broadcast_username` | TEXT | да | изменяемое | Публичный username связанного broadcast-канала — **first-class атрибут идентичности**: публичный хэндл для JOIN (вступить в ещё не встреченный канал без username/ссылки нельзя) и для отображения/сверки. Физически это уже хранимый `channelUsername` (§5.1), не новый дубль. NULL — приватный/нет. (R1) |
| `linked_broadcast_access_hash` | TEXT | да | **auth-session-scoped** | `access_hash` связанного broadcast-канала. Подчиняется тому же правилу валидности. (R2–R4) |
| `linked_broadcast_access_hash_updated_at` | INTEGER | да | **auth-session-scoped** | Провенанс `access_hash` связанного канала. NULL ⇔ хэш NULL. |
| `membership` | TEXT | нет | состояние | `member` \| `left` \| `banned` \| `not_found`. **Целевой дом** факта членства; на переходный период сосуществует со `status` через dual-write (§2.3). (R1) |
| `membership_updated_at` | INTEGER | да | состояние | Unix-секунды последней смены `membership`. Нужен потребителям, которым важно «когда стал banned/not_found» (сейчас они читают `statusUpdatedAt`, §2.3). |
| `migrated_to_id` | TEXT | да | стабильное | Для `basic_group`, мигрировавшей в супергруппу: marked id новой megagroup — «надгробие» и мост преемственности (R6). NULL в норме. |

Пометка «класс»: **стабильное** переживает переавторизацию и смену аккаунта;
**auth-session-scoped** действительно только в рамках текущей `sessionString`;
**состояние** меняется по событиям join/leave/ban/исчезновения из диалогов.

Индексы целевой схемы:

- PK по `marked_id` (уже уникальный доступ по ключу).
- `idx_peer_linked_broadcast (linked_broadcast_id)` — обратный поиск «по
  broadcast найти обсуждение» (нужен post-watch/анализу вне скоупа; в чистой
  identity-модели не обязателен — добавлять только если появится потребитель).

Замечание по простоте: отдельная таблица «Авторизация агента» в БД **не
заводится**. Логический атрибут «момент текущей авторизации» —
`session_authorized_at` — живёт рядом с `sessionString` в `tg-account.json`
(решение координатора 3), а не строкой в БД. Это исключает рассинхрон «сессия
сменилась, а отметка в БД — нет» и держит правило инвалидации однодомным.

### 2.2. Провенанс и правило валидности `access_hash`

Два таймстампа, одни системные часы (процесс/хост один), сравнение `>=`:

- `session_authorized_at` — момент записи текущей `sessionString`. Хранится в
  `tg-account.json` агента (не в БД).
- `access_hash_updated_at` — момент записи `access_hash` в строке peer (в БД).

Правило (на чтении, перед сборкой `InputPeer`):

```
accessHashValid(row, sessionAuthorizedAt) :=
    row.access_hash IS NOT NULL
    AND row.access_hash_updated_at IS NOT NULL
    AND row.access_hash_updated_at >= sessionAuthorizedAt
```

Тот же предикат отдельно применяется к
`linked_broadcast_access_hash` / `linked_broadcast_access_hash_updated_at`.

Следствия (ровно как в решении 3 координатора):

- **Reauth** пишет `session_authorized_at = now` в `tg-account.json` и **не
  трогает БД**. Все строки с более старым `access_hash_updated_at` на следующем
  чтении автоматически невалидны — переполучаются в текущей авторизации и
  перезаписываются (перезапись обновляет и `access_hash_updated_at`).
- **basic group**: `access_hash` NULL, правило неприменимо — `InputPeerChat`
  строится по одному `marked_id`.
- **Отказ API по конкретному peer** (`PEER_ID_INVALID` / `CHANNEL_INVALID`) при
  формально валидном таймстампе ⇒ точечно инвалидировать/переполучить эту
  строку (обнулить `access_hash`+`access_hash_updated_at`, переполучить). Это
  ловит редкий случай серверного обновления `access_hash` в пределах той же
  авторизации (см. `telegram-domain-model.md` §3.3).

Почему таймстампы, а не «тег эпохи» и не эагерное обнуление (обоснование
решения 3): тег эпохи потребовал бы хранить эпоху и в БД, и в конфиге и
синхронно инкрементировать — лишняя сущность и точка рассинхрона. Эагерное
обнуление при reauth означало бы проход по всей `channels.db` в момент
переавторизации (запись во все строки) — при этом reauth не всегда имеет
контекст БД под рукой и не должен её трогать. Сравнение таймстампов даёт тот же
результат лениво, одной записью в конфиг, без касания БД.

### 2.3. Членство (`membership`) — новое поле, переходное сосуществование с `status`

Решение координатора по O-4: факт «состоит / вышел / забанен / не найден» —
это **отдельное поле `membership`**, а не производная от `status`. Целевой дом
факта членства — `membership`; но переход выполняется **без ломки текущих
потребителей** (решение по R-1, §7).

Почему членство концептуально не место в `status`: сегодня `status` смешивает
два независимых факта — членство (`banned`/`not_found`/`leaved_from_banned`/
`leaved_manual`) и прикладной режим канала
(`format_error`/`suspend`/`only_comment`/`sleep`). Из-за смешения, например,
`suspend` (временная приостановка) и «агент вышел» не могут сосуществовать в
одном поле, хотя это ортогональные факты. `membership` даёт членству
собственный дом, меняющийся независимо от `status`.

**Переходное сосуществование (dual-write).** В этом change `status` **НЕ
вычищается**: членские значения (`banned`/`not_found`/`leaved_*`/`should_leave`)
остаются в `status`, все вне-скоупные потребители продолжают читать `status` без
изменений. `membership` вводится **дополнительно** и заполняется параллельно:

- миграция **популирует** `membership` из текущего `status` (derive, §5.1.1),
  `status` при этом оставляет как есть;
- на всех существующих сайтах записи членского факта (join / leave / ban /
  not_found) добавляется запись `membership` **рядом** с текущей записью
  `status` (dual-write, перечень сайтов — §6).

Это осознанно принятое **временное дублирование** факта членства (нарушение
«один факт — один дом» на переходный период). Управление рассинхроном: единый
приём — членский факт всегда пишется в оба поля в одной и той же операции
(в идеале в одной транзакции той же функции слоя БД), поэтому поля не расходятся
между записями. Новых точек записи членства не появляется — dual-write
добавляется ровно в существующие.

`membership_updated_at` — момент последней смены членства (пишется вместе с
`membership`). Он нужен, потому что после перевода потребителей (будущий change)
временны́е выборки членства (напр. «сколько каналов стали `banned` за отчётные
сутки» — `countChannelsBannedInWindow`) должны опираться на якорь именно
членства, а не на `statusUpdatedAt`. Это минимальное добавление — зеркало уже
существующего `statusUpdatedAt`, не новая абстракция.

**План сходимости (отдельный будущий change).** Перевод вне-скоупных
потребителей членских значений `status` на чтение `membership`, а затем
вычистка членских значений из `status` (`status` остаётся только с
`format_error`/`suspend`/`only_comment`/`sleep`) — вынесены в **отдельный
будущий change**, вне рамок этой модели. Порядок обязателен: сначала перевод
всех читателей на `membership`, только потом удаление значений из `status`
(иначе регресс — вышедшие/забаненные каналы исчезнут из выборок). Список
читателей, которые предстоит перевести, — R-1 (§7). До этого change dual-write
держит оба поля согласованными.

## 3. Алгоритмы

### 3.1. Сборка `InputPeer` с проверкой валидности

Вход: `marked_id`, строка peer из БД, `session_authorized_at` из
`tg-account.json`. Выход: `Api.TypeInputPeer`.

```
buildInputPeer(markedId):
  1. Если markedId уже в peerCache → вернуть (рабочая копия текущей
     авторизации, решение 5). peerCache в память кладут только валидные
     полные (не min) access_hash из getDialogs — см. cachePeerForDialog.
  2. row := SELECT ... FROM peer WHERE marked_id = markedId
  3. Если row.peer_type = 'basic_group':
        peer := InputPeerChat(chatId = rawId(markedId))   // access_hash не нужен
        peerCache.set(markedId, peer); вернуть peer
  4. Иначе (broadcast / megagroup):
        Если accessHashValid(row, session_authorized_at):
            peer := InputPeerChannel(rawId(markedId), row.access_hash)
        Иначе:
            peer := reacquire(row)      // §3.2
        peerCache.set(markedId, peer); вернуть peer
```

`rawId(markedId)` — через `utils.resolveId(bigInt(markedId))`, как уже делает
`seedPeerCache` (не изобретать свою арифметику `-100`-префикса).

### 3.2. Переполучение `access_hash` при невалидности (R4) — id-only

Идентификация опирается на **стабильный marked id** (R1). Путь один, без
резолва по username:

```
reacquire(row):
  populatePeerCacheForIds([row.marked_id])   // «встреча» через проход диалогов,
                                             // якорь — стабильный marked id
  h := peerCache.get(row.marked_id)
  Если h получен:
        UPDATE peer SET access_hash = h.access_hash,
                        access_hash_updated_at = now
              WHERE marked_id = row.marked_id
        вернуть InputPeerChannel(...)
  Если не получен (peer недоступен/не в диалогах):
        пометить membership = not_found при необходимости, сигнализировать
        вызывающему «peer недоступен» — операция join/read/leave по нему
        в этот прогон не выполняется.
```

Почему только `populatePeerCacheForIds` и никакого `ResolveUsername`:

- **`access_hash` нельзя получить из голого id никаким RPC** — в MTProto его
  нужно «встретить» (encounter): через диалоги, список участников, пересылки
  (подтверждено офиц. докой Telegram/Telethon). GramJS `StringSession` **не
  персистит entity-кэш** (причина — ADR-0003), поэтому «встреча» для нас — это
  именно наш проход диалогов (`populatePeerCacheForIds`) + `peerCache` в памяти
  процесса.
- **`reacquire` вызывается только для peer, в котором агент состоит** (членство
  — предпосылка операций read/leave и валидности строки), поэтому проход
  диалогов гарантированно вернёт свежий `access_hash` — в том числе для
  **приватного обсуждения без username**. Отдельный «публичный» путь по username
  не нужен.
- **Убирает риск перехвата username.** `id` стабилен, `username` изменяем и
  может сменить владельца — `ResolveUsername` мог бы вернуть другой peer с тем же
  именем. Якорь на marked id этот класс ошибок исключает.

Ограничение: peer, в котором агент НЕ состоит, через `reacquire` переполучить
нельзя — но это и не операция членства (вступление в ещё не встреченный peer
идёт через публичный хэндл/ссылку на пути join, не через `reacquire`; см. §3.6
про роль `channelUsername`). Для рабочего контура ограничения нет: монитор
всегда проходит `getDialogs`/`listGroupChannels` и прогревает `peerCache` до
операций.

### 3.3. Отказ API по конкретному peer

```
onPeerApiError(markedId, err):
  Если tag(err) ∈ {PEER_ID_INVALID, CHANNEL_INVALID}:
      peerCache.delete(markedId)
      UPDATE peer SET access_hash = NULL, access_hash_updated_at = NULL
            WHERE marked_id = markedId
      // следующий buildInputPeer пойдёт в reacquire (§3.2)
```

### 3.4. Резолв связи discussion → broadcast

Механизм уже есть (`resolveLinkedBroadcast`, `joinDiscussionGroups`): для
megagroup-обсуждения `GetFullChannel.fullChat.linkedChatId` → объект канала из
`chats` того же ответа. Целевое хранение:

```
onLinkResolved(megagroupMarkedId, broadcast):
  UPDATE peer SET
      linked_broadcast_id = markedId(broadcast.id),
      linked_broadcast_access_hash = broadcast.access_hash,
      linked_broadcast_access_hash_updated_at = now
  WHERE marked_id = megagroupMarkedId
```

Связь (`linked_broadcast_id`) — стабильна, пишется один раз. `access_hash`
связанного канала — auth-session-scoped, живёт по правилу §2.2 и переполучается
через тот же `GetFullChannel` обсуждения (megagroup даёт `linkedChatId` обратно
на broadcast).

### 3.5. Обработка миграции basic_group → супергруппа (R6)

> **Статус: ОТЛОЖЕНО** (решение координатора 25.09, редкий случай — агенты почти
> всегда работают с каналами/супергруппами). Уточнение по `api/channel`: платформа
> poll-based (живые апдейты не потребляет), а после change `monitor-v5-hash-driven-sync`
> `syncChannels` идёт только по устареванию хэшей (≈после reauth), не периодически —
> значит миграция сама собой между reauth НЕ обработается. Надёжный вектор (когда
> вернёмся) — read-time служебное `messageActionChatMigrateTo` при обращении к старому
> basic group (требует потрошить service-messages в `getMessages`). Колонка
> `migrated_to_id` заведена как задел. См. память
> `project_basic_group_migration_detection_deferred`. Ниже — исходный набросок логики.

Признак: у объекта `chat` взведён `deactivated` и заполнен `migrated_to`
(InputChannel нового канала) — см. `telegram-domain-model.md` §«Chat vs
супергруппа». В диалогах и в апдейтах это всплывает как новая megagroup с новым
marked id.

```
onBasicGroupMigrated(oldBasicMarkedId, migratedToChannel):
  newMarkedId := markedId(migratedToChannel.id)   // -100…
  // 1. Надгробие старой сущности — не теряем связь (R6)
  UPDATE peer SET migrated_to_id = newMarkedId, membership = 'left'
        WHERE marked_id = oldBasicMarkedId
  // 2. Новая сущность — обычная megagroup, подпадает под правило access_hash
  UPSERT peer (marked_id = newMarkedId, peer_type = 'megagroup',
               title, username, access_hash, access_hash_updated_at = now,
               membership = 'member')
```

Прикладное состояние старой строки (вне скоупа: метрики, статусные таймеры)
на новую строку **не переносится** — это отдельная сущность Telegram. Модель
идентичности сохраняет только преемственность через `migrated_to_id` и не теряет
чат (AC-5). Перенос прикладных данных, если понадобится, — задача владельцев тех
колонок, вне этой модели.

### 3.6. Роль username: только join и идентификация, не переполучение хэша

После правки §3.2 `username` **не участвует в переполучении `access_hash`** —
reacquire опирается только на marked id (проход диалогов). Роль username в модели
сужается до двух функций, где id недостаточно:

- **JOIN ещё не встреченного peer.** Для peer, в котором агент пока не состоит,
  `access_hash` взять неоткуда (его нельзя «встретить» без диалога), поэтому
  вступление идёт через публичный хэндл: `ResolveUsername(handle)` → (для канала
  с обсуждением) `GetFullChannel` → `linkedChatId` → вступление в обсуждение. Это
  единственный путь для нового peer, и здесь username обязателен как вход. Сам
  вход (ссылка/username закреплённого канала) приходит из реестра закреплений
  (`discovery.db`, §5.3), не из этой модели; в модели username хранится как
  идентификатор для сверки и повторного join.
- **Идентификация/сверка.** Публичный хэндл — человекочитаемый якорь при
  сопоставлении строк, отчётах и ручных проверках.

Приоритет публичного хэндла: **`linked_broadcast_username` (канал) — основной**,
`username` самого обсуждения — вторичный. Причина: у супергруппы-обсуждения
публичного username обычно нет, а публичен именно broadcast-канал; и join идёт
через канал (`ResolveUsername(channelUsername)` → `linkedChat`), а не через
обсуждение. Для standalone-broadcast (агент читает сам канал, без обсуждения)
peer и есть канал — тогда его username в поле `username` и является основным.

Итог: **переполучение хэша — строго по id (§3.2); username (в первую очередь
канала) — хранимый идентификатор для join и сверки, не для reacquire.**

## 4. Хранение `session_authorized_at`

### 4.1. Где

Поле `session_authorized_at: number` (unix-секунды) в `tg-account.json`, рядом с
`sessionString`. В `AccountConfig` (`src/core/config.ts`) добавляется
опциональное поле; `loadAccountConfig`/`loadPoolAccountConfig` его читают.
Опциональность нужна для обратной совместимости со старыми конфигами
(см. §4.3).

Обоснование (решение 3): один процесс обслуживает одного агента, часы одни;
хранение рядом с `sessionString` делает «момент авторизации» и саму сессию
одним фактом в одном доме — их нельзя рассинхронизировать.

### 4.2. Кто пишет

`session_authorized_at = now` пишется **в тот же момент, что и новая
`sessionString`**, во всех точках из §1:

| Точка | Действие |
|---|---|
| `writeSessionString` (reauth-from-tdata) | добавить запись `raw.session_authorized_at = now` рядом с `raw.sessionString`. **Главная точка**, драйвит и sweep. НЕ трогает `channels.db`. |
| `promoteToWorkspace` (autoregistration) | новый конфиг несёт `session_authorized_at = now` при создании. |
| `promoteToPool` (pool-provision) | конфиг пула несёт `session_authorized_at = now` при создании сессии пула. |
| `buildIncoming` (banned-account-replacement) | `sessionString` берётся из конфига пула — вместе с ней переносится и `session_authorized_at` пула. Новой сессии здесь не создаётся, отдельная запись не нужна. Старая `channels.db` уничтожается на `commitSwap` (§5.3), унаследованных `access_hash` у нового аккаунта нет. |
| `authSignIn` (интерактивный логин) | сам не персистит; его вызывающая сторона при записи `sessionString` в конфиг должна проставить `session_authorized_at = now`. |

Правило для будущего кода: **любая запись `sessionString` в `tg-account.json`
обязана в той же операции проставить `session_authorized_at = now`.** Иначе
свежая сессия будет читать устаревшие `access_hash` как валидные.

### 4.3. Семантика отсутствующего `session_authorized_at`

Для существующих конфигов (до внедрения) поле отсутствует. Правило чтения:

- **Отсутствует `session_authorized_at`** ⇒ трактовать как «неизвестно» и
  считать любой сохранённый `access_hash` **невалидным** (переполучать). То есть
  при отсутствии отметки `accessHashValid` возвращает `false`.

Это безопасный дефолт (лучше лишний раз переполучить, чем обратиться по
устаревшему хэшу). Он же снимает необходимость в разовом бэкафилле конфигов:
первая же реавторизация/пересоздание сессии проставит отметку штатно. Если
координатор предпочтёт разовый бэкафилл `session_authorized_at = now` во все
`tg-account.json` при внедрении — это тоже корректно (см. §5, миграция строк с
`access_hash` без таймстампа даёт тот же исход).

## 5. Миграция текущей `channels.db`

### 5.1. Сопоставление колонок

Целевая identity-модель ложится на существующую `channels` так (одна строка =
один peer, которым остаётся `chatId`):

| Целевое поле | Источник в текущей `channels` | Преобразование |
|---|---|---|
| `marked_id` | `chatId` | как есть (уже marked) |
| `peer_type` | вывести из `chatId` | `-100…` ⇒ `megagroup`; `-id` без `-100` ⇒ `basic_group` (дефолт O-2, §7). Уточняется первым живым `getDialogs`/`GetFullChannel`, где флаги `broadcast`/`megagroup` явные. |
| `username` | `chatUsername` | как есть. Это username самого обсуждения — вторичный, обычно NULL (у супергрупп-обсуждений публичного username чаще нет). |
| `linked_broadcast_username` | `channelUsername` | как есть. First-class публичный хэндл (для join/сверки, §3.6) — уже хранится, отдельной колонки не заводим. |
| `title` | `title` | как есть |
| `access_hash` | `chatAccessHash` | как есть (значение), но см. таймстамп ниже |
| `access_hash_updated_at` | — (нет источника) | **NULL** при миграции ⇒ старый `chatAccessHash` невалиден на первом чтении |
| `linked_broadcast_id` | `channelId` | конверсия raw → marked **на чтении** (дефолт O-3, §7); столбец `channelId` остаётся raw для вне-скоупного post-watch, новую колонку не заводим |
| `linked_broadcast_access_hash` | `channelAccessHash` | как есть (значение) |
| `linked_broadcast_access_hash_updated_at` | — | **NULL** при миграции ⇒ невалиден на первом чтении |
| `membership` | из `status` (§5.1.1) | разовый бэкафилл по таблице отображения §5.1.1 |
| `membership_updated_at` | `statusUpdatedAt` — только если исходный `status` кодировал членство | иначе NULL |
| `migrated_to_id` | — | NULL (нет исторических данных) |

Вне скоупа и **сохраняются как есть**: `lastProcessedAt`, `status` (и
`statusUpdatedAt`/`statusDurationSeconds`/`status_description`), `channelResolved`,
`channelTitle`, `avg_views`/`subs_count`/`coverage_updated_at`,
`active_writers_*`/`activity_updated_at`, `channel_context*`,
`lastSeenChannelPostId`/`watchedThreadRootMsgId`/`lastCheckedTarget*`,
`write_access_reason`/`write_access_until`, таблицы `dm_candidates`/`sync_state`.

Трактовка сохранённых `access_hash` без таймстампа: `access_hash_updated_at` и
`linked_broadcast_access_hash_updated_at` при миграции остаются **NULL**. По
правилу §2.2 такой хэш невалиден — первое же обращение переполучит и перезапишет
его с корректным таймстампом. Это ровно то поведение, которого требуют R2/R3
(до внедрения система не умела инвалидировать — значит любой унаследованный хэш
следует считать подозрительным).

### 5.1.1. Отображение `status` → `membership` (O-4)

Разовый бэкафилл при миграции: `membership` **популируется** (derive) из
текущего `status`. `status` при этом **оставляем как есть** — членские значения
из него НЕ удаляются (переходное сосуществование, §2.3; вычистка — отдельный
будущий change, §7).

| Исходный `status` | → `membership` (populate) | `status` после миграции | `membership_updated_at` |
|---|---|---|---|
| `banned` | `banned` | `banned` (не трогаем) | ← `statusUpdatedAt` |
| `not_found` | `not_found` | `not_found` (не трогаем) | ← `statusUpdatedAt` |
| `leaved_from_banned` | `left` | `leaved_from_banned` (не трогаем) | ← `statusUpdatedAt` |
| `leaved_manual` | `left` | `leaved_manual` (не трогаем) | ← `statusUpdatedAt` |
| `should_leave` | **`member`** | `should_leave` (не трогаем) | NULL |
| `suspend` | `member` | `suspend` (не трогаем) | NULL |
| `format_error` | `member` | `format_error` (не трогаем) | NULL |
| `only_comment` | `member` | `only_comment` (не трогаем) | NULL |
| `sleep` | `member` | `sleep` (не трогаем) | NULL |
| NULL | `member` | NULL | NULL |

Замечания:

- **`should_leave` → `member`** (решение координатора). `should_leave` — это
  pending-**действие** («пора выйти»), а не состояние членства: агент физически
  ещё в чате, значит по членству он `member`. Само `should_leave` остаётся в
  `status` (это его дом) и продолжает драйвить очередь выхода
  `leave-banned-channels` без изменений. В `membership` намерение выхода не
  переносится.
- `leaved_from_banned`/`leaved_manual` → `left`: это уже свершившийся выход,
  агент вне чата.
- `suspend`/`format_error`/`only_comment`/`sleep` → `member`: это прикладные
  режимы канала, в котором агент состоит; членство при них — `member`. Именно
  разделение полей снимает коллизию «suspend vs вышел» (§2.3).

### 5.2. Вариант миграции — выбор за координатором

Целевая identity-модель делит текущие поля на «своё» (`chatId`/`chatAccessHash`/
`chatUsername`/`title`) и «связанный канал» (`channelId`/…), но физически всё
это — одна таблица `channels`, обвешанная колонками вне скоупа. Отсюда два
варианта.

| Критерий | Вариант A: аддитивные ALTER | Вариант B: пересоздание таблицы |
|---|---|---|
| Суть | Добавить недостающие колонки (`peer_type`, `*_updated_at`, `membership`, `migrated_to_id`) через `ALTER TABLE ADD COLUMN`; идентичность продолжает жить в существующих `chatId`/`chatAccessHash`/`channelId`/…, переименований нет. | Создать новую таблицу строго по §2.1, перелить данные по §5.1, вне-скоупные колонки вынести в отдельную таблицу или оставить в старой; переключить код. |
| Соответствие уже принятому стилю | Полное — весь `channels.ts` мигрирует только аддитивно (`migrate*Columns`, `ADD COLUMN IF NOT EXISTS`-паттерн). | Разрыв со стилем; SQLite не умеет `DROP/RENAME COLUMN` дёшево, пересоздание — copy+swap. |
| Риск для вне-скоупных потребителей | Минимальный: их колонки и запросы не двигаются. | Высокий: post-watch, метрики, write-access, dm-candidates, funnel читают `channels` напрямую — все запросы надо выверить. |
| Чистота имён | Остаётся двусмысленность `channelId` (raw, связанный канал) vs `chatId` (peer). | Имена по целевой модели, двусмысленность уходит. |
| Raw vs marked для связанного канала | `channelId` остаётся raw; marked-представление связи (`linked_broadcast_id`) либо новой колонкой, либо конвертацией на чтении. | `linked_broadcast_id` сразу marked. |
| Обратимость | Высокая (только добавление). | Низкая (пересоздание — необратимая операция над данными, требует явного подтверждения человека). |

Рекомендация к рассмотрению (не выбор — решает координатор): **Вариант A**. Он
согласован с принципом простоты и обратимости проекта, не задевает
вне-скоупных потребителей и даёт всё, что требуют R1–R6, через добавление
колонок `peer_type`, `access_hash_updated_at`, `chat_access_hash_updated_at`
(для `chatAccessHash`), `channel_access_hash_updated_at` (для `channelAccessHash`),
`membership`, `migrated_to_id`. Двусмысленность имён (`channelId` = связанный
broadcast) остаётся, но она уже задокументирована в коде и снимается
комментарием, а не рискованным переименованием. Вариант B оправдан, только если
координатор целенаправленно хочет вычистить схему `channels` целиком (тогда это
отдельный крупный change с учётом всех вне-скоупных потребителей).

Конкретно для Варианта A добавляемые колонки:

| Новая колонка | Тип | Дефолт при ALTER |
|---|---|---|
| `peer_type` | TEXT | `megagroup`/`basic_group` по виду `chatId` (O-2, §5.1); добор точного типа при первом резолве |
| `chat_access_hash_updated_at` | INTEGER | NULL (унаследованный `chatAccessHash` невалиден) |
| `channel_access_hash_updated_at` | INTEGER | NULL (унаследованный `channelAccessHash` невалиден) |
| `membership` | TEXT | populate из `status` по §5.1.1 (`NOT NULL` после бэкафилла; дефолт `member`) |
| `membership_updated_at` | INTEGER | из `statusUpdatedAt` для `banned`/`not_found`/`leaved_*`, иначе NULL (§5.1.1) |
| `migrated_to_id` | TEXT | NULL |

`membership` вводится как **новое** поле — целевой дом факта членства (§2.3).
Миграция только **популирует** его из `status`; `status` остаётся как есть,
членские значения из него НЕ удаляются в этом change. Оба поля держатся
согласованными dual-write на сайтах записи членства (§6). Перевод вне-скоупных
потребителей на `membership` и последующая вычистка `status` — отдельный будущий
change (план сходимости, §2.3 и §7 R-1).

### 5.3. Взаимодействие с заменой аккаунта (AC-3)

Разбор по коду (`banned-account-replacement`). Замена аккаунта **не меняется**
этой моделью; текущее поведение корректно.

Что происходит с данными при замене:

- **Старую per-account `tg-channels.db` уничтожает `commitSwap`** (`swap.ts:132`):
  боевой workspace переименовывается в `.old`, `.incoming` (из пула) — в боевой,
  затем `.old` удаляется целиком. Именно здесь исчезает `channels.db`
  заменяемого агента, **не** в `buildIncoming`.
- **`buildIncoming` чистит только `.incoming`** — каталог, пришедший из пула, где
  `channels.db` и так нет (пул несёт лишь сессию + tdata). Список стираемых там
  рабочих БД — `WORKING_DBS` (`swap.ts:22`, включает `tg-channels.db`) — это
  подстраховка «стартовать с чистым», а не точка гибели боевой БД.
- **`tasks.db` не стирается**, а переносится из старого workspace; внутри
  очищается только таблица `tasks`, журналы (`runs`/`error_log`/…) сохраняются
  (`swap.ts:90`).

Почему потеря `channels.db` при замене корректна и не нарушает суть AC-3:

- **Закрепление каналов за агентом — кросс-аккаунтный стабильный факт — живёт
  НЕ в `channels.db`, а в реестре закреплений** (`discovery.db`). После замены
  `activateAndFinalize` заново наполняет join-queue из реестра:
  `listAgentAssignmentLinks(adminAgentId, agentId)` → `addJoinQueue`
  (`run.ts:214-217`). Агент повторно вступает в те же каналы.
- **Per-account сведения (`access_hash`, membership) при замене обязаны
  сброситься**: `access_hash` привязан к аккаунту (О2) и на новом аккаунте
  недействителен, членство новый аккаунт устанавливает заново вступлением.
  Их пересоздание с нуля — не потеря, а корректный жизненный цикл: те же marked
  id (глобальны), тот же тип, та же связь discussion↔broadcast восстанавливаются
  повторным резолвом при join, а `access_hash`/membership заполняются свежими в
  новой авторизации.

Итог: стабильный факт «канал закреплён за агентом» переживает замену через
реестр; per-account идентичность (`access_hash`, membership) корректно
сбрасывается и восстанавливается повторным join. Формулировку AC-3
(«стабильные сведения сохраняются при замене аккаунта») уточняет аналитик:
сохраняется **закрепление за агентом** (в реестре), а per-account сведения
сбрасываются и восстанавливаются re-join. Правило `session_authorized_at`
(§4.2): новый аккаунт несёт `session_authorized_at` из конфига пула; пустая
`channels.db` означает, что унаследованных `access_hash` нет вовсе — коллизии
устаревших хэшей на замене не возникает по построению.

## 6. Влияние на код

Без написания кода — только перечень мест и характер изменения.

- **`src/core/config.ts`**: в `AccountConfig` (и `PoolAccountConfig`) добавить
  опциональное `session_authorized_at`; `loadAccountConfig`/`loadPoolAccountConfig`
  — читать его.
- **`writeSessionString`** (`tg-agent-reauth-from-tdata/run.ts`): писать
  `session_authorized_at = now` рядом с `sessionString`. `channels.db` не трогать.
- **`promoteToWorkspace` / `promoteToPool`** (autoreg, pool-provision): включить
  `session_authorized_at = now` в записываемый конфиг.
- **Чтение батча каналов** (потребители `getPostWatchChannels`,
  `getChatAccessHash`, будущий общий геттер identity): применять правило §2.2 к
  `access_hash`/`chatAccessHash`/`channelAccessHash` перед использованием;
  невалидные — не сидировать в `peerCache`, а помечать «требует переполучения».
- **`seedPeerCache` + `getChatAccessHash`** (`service.ts` / `channels.ts`,
  холодный путь review-listener `review-listener.ts:49-55`): сейчас читают
  `chatAccessHash` из БД и сидируют `peerCache` **без проверки актуальности**,
  минуя `getDialogs` (подтверждено по коду). После изменения — сидировать только
  если `accessHashValid`; иначе переполучить проходом диалогов
  (`populatePeerCacheForIds([chatId])`, §3.2) перед отправкой. Агент —
  участник чата, поэтому проход диалогов вернёт свежий `access_hash` и для
  приватного обсуждения без username (закрытие O-5, §7). Это закрывает основной
  баг R2/R3 на холодном пути.
- **Сайты dual-write `membership`** (пишем `membership` РЯДОМ с текущей записью
  `status`, в той же операции, `membership_updated_at = now`; `status` не
  меняем). Все сайты — в слое БД `channels.ts`, куда стекаются существующие
  пути записи членского факта:
  - `upsertChannelIdentityFromJoin` (успешный join) → `membership='member'`;
  - `markChannelStatus` при `status='banned'` (вызовы из `monitor-v2.ts:291`,
    `monitor-v5.ts:550`) → `membership='banned'`. Для нечленских значений
    (`suspend`/`format_error`/`only_comment`/`sleep`) `membership` НЕ трогается
    — эта функция пишет и членские, и прикладные статусы, dual-write срабатывает
    только для `banned`;
  - `setLeftChannelStatus` (выход из `leave-banned-channels.ts:128`,
    `leaved_from_banned`/`leaved_manual`) → `membership='left'`;
  - `syncChannels` — `markNotFoundStmt` → `membership='not_found'`;
    `clearNotFoundStmt` (возврат в диалоги) → `membership='member'`;
  - `resetChannelStatuses` (разовая миграция channel-not-found-recovery,
    сбрасывает статус в NULL) → `membership='member'`.
  Новых точек записи членства не вводим — dual-write добавляется ровно в эти.
- **Потребителей членства в этом change НЕ трогаем.** `getChannelsBatch`,
  `countChannels`/`countRecentlyBannedChannels`/`countChannelsBannedInWindow`,
  `getPostWatchChannels`, `TERMINAL_STATUSES` в `syncChannels`, funnel
  (`funnel-collect`/`funnel-report`), `channel-rotation`, мониторы v2–v5,
  `leave-banned-channels`, `join-queue` продолжают читать `status` как сейчас.
  Их перевод на `membership` и вычистка `status` — отдельный будущий change
  (план сходимости, §2.3, §7 R-1).
- **`cachePeerForDialog`** (`service.ts`, горячий путь): не меняется по логике
  сборки `InputPeer`, но точки **персиста** (`saveChatAccessHash`,
  `saveChannelIdentity`, `upsertChannelIdentityFromJoin`) должны писать
  соответствующий `*_updated_at = now` вместе с самим `access_hash`.
- **`upsertChannelIdentityFromJoin`** (`channels.ts`): при join известны свежие
  `chatAccessHash`/`channelAccessHash` в текущей авторизации — писать их
  `*_updated_at = now`; проставлять `peer_type` (из объекта Telegram —
  `broadcast`/`megagroup`) и `membership='member'`.
- **`initChannels` миграции** (`channels.ts`): добавить `migratePeerIdentityColumns`
  (Вариант A) тем же аддитивным паттерном, что и существующие `migrate*Columns`.
- **Обработка миграции basic→super** (§3.5): новое поведение на пути
  синхронизации диалогов/апдейтов — распознавать `deactivated`+`migrated_to`.
  Сейчас такого распознавания в коде нет (проверено: `migrated_to`/`migratedTo`
  не встречается). Это новая способность в рамках R6.

## 7. Решения по бывшим открытым вопросам и риски

### 7.1. Закрытые вопросы

- **O-1 (AC-3 и замена аккаунта) — РЕШЕНО.** Текущее поведение корректно,
  `swap.ts` не меняется. Уничтожение per-account `channels.db` происходит в
  `commitSwap` (удаление `.old`), а не в `buildIncoming`. Кросс-аккаунтный
  стабильный факт (закрепление канала за агентом) живёт в реестре
  (`discovery.db`) и переживает замену через
  `listAgentAssignmentLinks`→`addJoinQueue`; per-account сведения (`access_hash`,
  membership) корректно сбрасываются и восстанавливаются повторным join. Полный
  разбор — §5.3. Формулировку AC-3 уточняет аналитик.
- **O-2 (`peer_type` broadcast vs megagroup при миграции) — дефолт принят.**
  Для `-100…` при миграции ставится **`megagroup`** (агент вступает в
  обсуждения — доминирующий случай), для `-id` без `-100` — `basic_group`.
  Точный тип уточняется первым живым `getDialogs`/`GetFullChannel`, где флаги
  `broadcast`/`megagroup` явные. Обоснование: тип не влияет на сборку `InputPeer`
  (и broadcast, и megagroup → `InputPeerChannel`), только на семантику модели, —
  риск неверного дефолта низкий и самоисправляется на первом резолве.
- **O-3 (raw vs marked для связанного канала) — дефолт принят.** Связь
  `linked_broadcast_id` вычисляется **конверсией `channelId` (raw) → marked на
  чтении** (`utils`-арифметика `-100`-префикса). Новой колонки не заводим,
  существующий `channelId` остаётся raw. Обоснование: вне-скоупный post-watch
  читает `channelId` как raw (`getPostWatchChannels`) — переопределять смысл
  колонки нельзя; конверсия на чтении дешева и ничего не добавляет в схему
  (принцип простоты).
- **O-4 (`membership` — отдельное поле) — РЕШЕНО.** `membership` — новое поле,
  целевой дом факта членства (§2.3), не производная от `status`. Отображение
  миграции `status`→`membership` — §5.1.1 (миграция только популирует
  `membership`, `status` не трогает). Переходное дублирование факта управляется
  dual-write (§6); вычистка `status` — отдельный будущий change (R-1 ниже).
- **O-5 (приватные peer без username на холодном пути) — дефолт принят.**
  Холодный путь review-listener (`review-listener.ts:49-55`) при невалидном
  `chatAccessHash` **переполучает `access_hash` проходом диалогов**
  (`populatePeerCacheForIds([chatId])`) перед отправкой. Агент — участник чата,
  поэтому проход диалогов вернёт свежий хэш даже для приватного обсуждения без
  username. Неустранимый случай (приватный peer без username, в котором агент НЕ
  состоит) в операциях членства не встречается — такой peer нельзя ни читать, ни
  покинуть. Остаётся как небольшой риск R-2 (стоимость прохода диалогов на
  холодном пути).

### 7.2. Риски

- **R-1 (ripple `status`→`membership`) — РЕШЕНО (dual-write + будущий change).**
  В этом change `status` НЕ вычищается: `membership` вводится дополнительно и
  держится согласованным с членскими значениями `status` через dual-write на
  сайтах записи (§6). Вне-скоупные потребители продолжают читать `status` без
  изменений — регресса нет. Перевод этих потребителей на `membership` и
  последующая вычистка членских значений из `status` вынесены в **отдельный
  будущий change** (план сходимости — §2.3): обязательный порядок — сначала
  перевод всех читателей на `membership`, затем удаление значений из `status`.
  Читатели, подлежащие переводу в будущем: `getChannelsBatch`, `countChannels`,
  `countRecentlyBannedChannels`, `countChannelsBannedInWindow`,
  `getPostWatchChannels`, `TERMINAL_STATUSES` (`syncChannels`),
  funnel (`funnel-collect`/`funnel-report`), `channel-rotation`, мониторы v2–v5,
  `leave-banned-channels`, `join-queue`. `should_leave` в будущий change не
  входит — он остаётся pending-действием в `status` (§5.1.1), не членством.
  Цена приёма: временное дублирование факта членства до будущего change —
  осознанно принято.
- **R-2 (стоимость холодного переполучения).** При невалидном `access_hash` на
  холодном пути (после reauth между постановкой ревью и кликом ревьюера)
  review-listener делает проход диалогов — сетевая стоимость на одну отправку.
  Случай редкий (reauth между двумя близкими событиями), деградация мягкая
  (задержка, не отказ). Заведомого блокера нет; отметить при реализации.

## 8. Резюме соответствия требованиям

| Требование | Как закрывается |
|---|---|
| R1 (стабильные сведения) | идентичность §2.1: стабильные `marked_id`/`peer_type`/`linked_broadcast_id` + факт `membership`; публичные хэндлы `username` (обсуждение) и `linked_broadcast_username` (канал, first-class, R1 «если есть») — класс «изменяемое»; `title` — отображение |
| R2, R3 (не использовать хэш прошлой авторизации) | правило валидности §2.2: `access_hash_updated_at >= session_authorized_at`; reauth сдвигает `session_authorized_at` (§4.2) |
| R4 (переполучение при отсутствии валидного хэша) | §3.1–3.2: `buildInputPeer` → `reacquire` строго по стабильному marked id (проход диалогов), без резолва по username |
| R5 (basic group без `access_hash`) | `peer_type='basic_group'`, `InputPeerChat` по одному id (§3.1, шаг 3) |
| R6 (миграция basic→super без потери) | `migrated_to_id` + upsert новой megagroup (§3.5) |

## 9. Синхронизация monitor-v5: обновление хэшей по устареванию + read-time not_found

Продолжение модели: как поддерживается свежесть `access_hash` в рабочем цикле
`monitor-v5` и как ловится `not_found`. В реализованном ядре tg-peer-identity-model
эту часть сознательно не трогали — оставили суточный полный синк. Здесь —
целевой дизайн (проектирование, не реализация).

### 9.1. Текущее состояние (источник истины — код)

`monitor-v5` держит свежесть хэшей двумя механизмами:

- **Суточный полный синк** (Шаг 3/3b, `monitor-v5.ts`): гейт
  `isFullSyncDue(agentId, V5_FULL_SYNC_PERIOD_SECONDS=86400)` — раз в сутки
  `listGroupChannels()` тянет диалоги из Telegram, `syncChannels()` сверяет
  список, персистятся свежие `chatAccessHash` (`saveChatAccessHash`),
  `cacheChannelIdentities()` освежает идентичность связанных каналов. Отметка —
  `markFullSyncDone` в `sync_state.lastFullSyncAt`.
- **Досев из БД между синками** (Шаг 5.0): `getFreshChatAccessHash(agentId,
  chatId, sessionAuthorizedAt)` — сидирует `peerCache` из БД **только если хэш
  свежий** по правилу §2.2 (провенанс уже внедрён). Устаревший — не сидирует,
  `getPeerDialog` вернёт null, канал пропускается до ближайшего полного синка.

`not_found` сейчас ставит **только** `syncChannels` (канал есть в БД, но пропал
из диалогов — `markNotFoundStmt`). По флоту это массовый исход: 406 каналов,
2-й по частоте после активных. Убирая суточный таймер, этот детект надо заменить.

### 9.2. Триггер полного прохода по устареванию (замена таймера)

**Решение:** суточный таймер убрать; полный проход диалогов
(`listGroupChannels` + `syncChannels` + персист хэшей + `cacheChannelIdentities`)
триггерить **по факту устаревания хэшей**, а не по расписанию. Гейт Шага 3/3b
заменяется предикатом:

```
hasStaleAccessHashes(agentId, sessionAuthorizedAt) :=
  EXISTS (
    SELECT 1 FROM channels
    WHERE membership = 'member'
      AND (chat_access_hash_updated_at IS NULL
           OR chat_access_hash_updated_at < sessionAuthorizedAt)
  )
```

- **Ограничение `membership = 'member'` обязательно.** Строки `not_found`/`left`
  штатно имеют NULL/устаревший хэш (агент вне чата, переполучать нечего). Без
  фильтра по членству они бы **вечно** числились устаревшими и запускали полный
  проход каждый прогон — таймер сменился бы на «всегда due». Фильтр по `member`
  оставляет в предикате только те каналы, где свежий хэш действительно нужен и
  достижим (агент — участник, проход диалогов его вернёт, §3.2).
- **Поведение:** сразу после reauth `sessionAuthorizedAt` сдвинулся вперёд →
  все member-хэши стали старше → предикат true → один полный проход освежает их
  все разом. Пока новых reauth нет, предикат false — лишних проходов нет
  (в отличие от суточного таймера, который ходил и когда всё свежо).
- Полный проход — тот же, что сегодня (Шаг 3/3b), меняется только его **гейт**:
  `isFullSyncDue(...)` → `hasStaleAccessHashes(...)`. `linked_broadcast_access_hash`
  освежается тем же проходом (`cacheChannelIdentities`), отдельного предиката не
  требует.

### 9.3. Read-time детект `not_found` (Вариант A)

Убрав суточный `syncChannels`, теряем его детект «пропал из диалогов». Заменяем
детектом **в момент чтения** канала в цикле monitor-v5.

**Эмпирика (проверено на живом агенте, agent121, боевые данные — §9.6).** Для
канала, где агент **НЕ участник**, при валидном сохранённом `chatAccessHash`
и `GetPeerDialogs`, и `GetHistory` **бросают `CHANNEL_PRIVATE`**, а не
возвращают пустой результат. Для реального участника `GetPeerDialogs` возвращает
диалог. То есть неоднозначного «`[]` у участника» не существует: участник → есть
диалог; не-участник → throw. Это радикально упрощает Вариант A — подтверждающий
пробинг не нужен.

**Единственная ветка детекта — `catch CHANNEL_PRIVATE` вокруг `getPeerDialog`.**
Сейчас monitor-v5 ловит исключение `getPeerDialog` (строка 406) и глушит в общий
`warn` → `dialogStatus = null` → `dialog_status_unknown` skip. Нужно: в этом
catch классифицировать тег — `channel_private` ⇒
`markChannelStatus(not_found)`. Те же `CHANNEL_PRIVATE` бросают `getMessages`
и `reply` — на их путях обработать тем же классификатором.

**Смысловой гейт `CHANNEL_PRIVATE` vs `CHANNEL_INVALID` (сохранить).**

- `CHANNEL_PRIVATE` при **свежем** засеянном хэше ⇒ хэш валиден, а доступа нет ⇒
  агент точно **не участник** ⇒ `not_found`.
- `CHANNEL_INVALID` / `PEER_ID_INVALID` ⇒ **протухший/ротированный** хэш ⇒ не
  сигнал о членстве ⇒ инвалидировать и переполучить (§3.3), не `not_found`.

Гейт корректен по построению модели провенанса: Шаг 5.0 сидирует `peerCache`
**только свежим** хэшем (`getFreshChatAccessHash`, §2.2). Значит запрос,
дошедший до сервера и вернувший `CHANNEL_PRIVATE`, нёс валидный хэш — исключение
достоверно про членство, а не про хэш. Если хэш устарел/не сидировался,
`getPeerDialog` даже не отправит запрос (нет `InputPeer` в кэше →
`service.ts:1096` `if (!peer) return null`) — вернётся null, а не throw.

**Таблица решений:**

| Результат `getPeerDialog` | Классификация | Действие |
|---|---|---|
| throw `CHANNEL_PRIVATE` (при свежем засеянном хэше) | не участник | `not_found` |
| throw `CHANNEL_INVALID` / `PEER_ID_INVALID` | протухший хэш | инвалидировать + переполучить (§3.3) |
| статус есть | участник | обычная обработка |
| null (хэша нет/не сидировали → запрос не ушёл) | членство неизвестно | `dialog_status_unknown` skip (хэш переполучит staleness-проход §9.2) |

Ключевое: **null НЕ означает `not_found`** — не-участники бросают, а не
возвращают null. Прежний `dialog_status_unknown` skip для null сохраняется без
изменений.

**Две точки правки в monitor-v5:**

1. **catch вокруг `getPeerDialog`** (сейчас 404-413): классифицировать тег
   пойманного исключения — `channel_private` → `not_found`;
   `channel_invalid`/`peer_id_invalid` → §3.3; прочее → прежний warn + null.
2. **блок `if(!dialogStatus)`** (сейчас 415-428): не меняется по сути —
   остаётся `dialog_status_unknown` skip (детект `not_found` полностью переехал
   в catch выше, отдельная ветка в этом блоке не нужна).

`not_found` ставится через `markChannelStatus(agentId, chatId, "not_found", ...)`
— он уже dual-write'ит `membership='not_found'` (§6). Тем самым канал сразу
выпадает из предиката §9.2 (перестаёт быть `member`) — вечного повторного
прохода из-за него не возникает.

**Заметка: `not_found` в БД бывает залипшим.** На живом агенте один из
кандидатов, помеченных `not_found`, оказался всё ещё участником (`GetPeerDialogs`
вернул диалог, `GetHistory` ok) — то есть пометка была устаревшей. Обратный
reconcile (снятие `not_found`, когда агент снова участник) сейчас делают два
пути: `clearNotFoundStmt` в полном проходе (`syncChannels`, канал снова в
диалогах) и `upsertChannelIdentityFromJoin` при повторном джойне через
join-queue (самолечение). Это не блокер новой модели — фиксируем как известное
свойство: залипший `not_found` со временем снимается одним из этих путей.

### 9.4. Комплементарность: дыры в детекте нет

Кик/выход агента из канала ловится одним из двух механизмов в зависимости от
момента относительно reauth:

- **Кик ПОСЛЕ reauth** → на ближайшем staleness-проходе (§9.2) канал не найдётся
  в диалогах → `syncChannels` поставит `not_found` (как сегодня). Полный проход
  всё равно запущен, потому что reauth сдвинул `sessionAuthorizedAt` и member-хэши
  устарели.
- **Кик МЕЖДУ reauth** (ничего не устарело, полного прохода нет, хэш свежий) →
  ловит read-time детект (§9.3): свежий хэш засеян (Шаг 5.0) → `getPeerDialog`
  дошёл до сервера → `CHANNEL_PRIVATE` → `not_found`.

Почему покрытие полное: между двумя reauth все member-хэши свежие (их освежил
проход сразу после предыдущего reauth), поэтому в рабочей волне монитора
member-канал всегда сидируется свежим хэшем и запрос доходит до сервера — кик
проявляется как `CHANNEL_PRIVATE` и ловится read-time детектом. Случай «хэш
устарел, запрос не ушёл, вернулся null» для member-канала до цикла чтения не
доходит: устаревший member-хэш сам по себе поднимает предикат §9.2 → staleness-
проход обрабатывает канал раньше (переполучает хэш либо ставит `not_found` через
`syncChannels`, если канала нет в диалогах). То есть staleness-проход и read-time
детект дополняют друг друга без окна, в котором кик остался бы незамеченным.

### 9.5. Сопутствующее

- **Разовый бэкафилл `sessionAuthorizedAt = now`** во все существующие
  `tg-account.json` при внедрении — **обязателен**. Без него у legacy-конфигов
  оба предиката (`accessHashFresh` §2.2 и `hasStaleAccessHashes` §9.2) не
  определены (`sessionAuthorizedAt = undefined` ⇒ `accessHashFresh` всегда false).
  **Разовый thundering-herd:** на первом прогоне после деплоя у всех агентов все
  хэши окажутся старше свежепроставленного `sessionAuthorizedAt` → у каждого
  агента ровно один полный проход диалогов. Нагрузка размазана диспетчером
  (агенты просыпаются в разное время, human-pacing), пик разовый.
- **Вычистка осиротевшего** (после удаления таймера ничем не читается):
  `sync_state.lastFullSyncAt`, `markFullSyncDone`, `isFullSyncDue`,
  `V5_FULL_SYNC_PERIOD_SECONDS`. Удаление — по принципу обратимости, с явного
  подтверждения; таблицу `sync_state` дропать миграцией (в ней только
  `lastFullSyncAt`).

### 9.6. Разрешённые вопросы (проверено эмпирически)

Оба вопроса закрыты пробингом на живом агенте (VPS, agent121, боевые данные).

- **OV-9.1 — РЕШЕНО.** `GetPeerDialogs` (и `GetHistory`) для не-участника с
  валидным сохранённым `chatAccessHash` **бросают `CHANNEL_PRIVATE`**, а НЕ
  возвращают `[]` (4 из 5 кандидатов not_found/leaved дали `CHANNEL_PRIVATE` на
  обоих вызовах). Для реального участника `GetPeerDialogs` возвращает диалог
  (`dialogs=1`), `GetHistory` ok. Следствие: детект `not_found` строится
  **только** на `catch CHANNEL_PRIVATE`, подтверждающий пробинг убран (§9.3).
  Пятый кандидат оказался всё ещё участником с залипшим `not_found` в БД — см.
  заметку про залипший `not_found` в §9.3.
- **OV-9.2 — РЕШЕНО (неактуально).** Архивных групп/каналов у агента 0 —
  платформа диалоги не архивирует, кейс «архивный участник» практически не
  существует. Отдельная обработка архива в дизайне не нужна.
