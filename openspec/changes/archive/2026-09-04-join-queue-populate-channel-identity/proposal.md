## Why

Сейчас строка `channels` (tg-channels.db) для только что вступленного канала
появляется не сразу и не полностью. `joinDiscussionGroups` (MTProto
`JoinChannel`) не пишет в БД вообще — строку создаёт только следующий
`syncChannels()` (вызывается из `monitor`/`monitor-v2`/`monitor-v3`/
`monitor-v4`/`monitor-v5` на их собственном расписании), причём только с
тремя полями (`chatId`, `title`, `chatUsername`). Остальные —
`channelId`/`channelAccessHash`/`channelUsername`/`channelResolved` —
заполняются ещё позже, отдельным вызовом `cacheChannelIdentities()`
(`core/channel-sync.ts`), лимитированным 20 непрорезолвленными чатами за тик
монитора.

При этом `resolveLinkedBroadcast`, который `cacheChannelIdentities`
использует для резолва привязанного канала, делает **отдельный**
`GetFullChannel`-запрос от группы обсуждения к каналу — хотя `joinDiscussionGroups`
буквально за несколько строк до вступления уже делает `GetFullChannel` от
канала к группе обсуждения (чтобы узнать `linkedChatId` и вступить). Тот же
факт («этот канал ↔ эта группа обсуждения») резолвится дважды отдельными
сетевыми вызовами, хотя весь набор идентичности уже есть в памяти в момент
успешного `JoinChannel`.

Практическое следствие (обнаружено 2026-08-28/29 во время работы над
`leave-banned-terminal-status`): после массового перераспределения каналов
локальная таблица `channels` часами отставала от реального Telegram-членства
— агент уже состоял в новых каналах, а БД об этом ещё не знала, что
несколько раз приводило к неверным подсчётам и путанице при сверке
`channels` ↔ `join_queue`.

## What Changes

- `joinDiscussionGroups` возвращает в `JoinResult` (при `status='joined'`)
  полный набор идентичности, уже резолвленной в процессе вступления:
  identity канала (`channelId`/`channelAccessHash`/`channelUsername`) и
  identity группы обсуждения (`chatId`/`title`/`chatAccessHash`/
  `chatUsername`).
- `chatId` строится через GramJS `utils.getPeerId()` (маркированный вид,
  `-100…`) — не `.id.toString()` (сырой вид), чтобы совпадать с форматом,
  который везде в БД пишет `syncChannels`.
- `join-queue.ts` на `status==='joined'` сразу пишет/дополняет строку
  `channels` этим полным набором, включая `channelResolved=1` — новая
  функция в `core/db/channels.ts` (idempotent, `INSERT OR IGNORE` +
  дозаполнение недостающих identity-полей, если строка уже существует).
- `cacheChannelIdentities`/`getUnresolvedChats` не меняются — уже
  резолвленные этим путём строки (`channelResolved=1`) естественным образом
  не попадают в их выборку, повторного `GetFullChannel` для них больше не
  происходит.
- `syncChannels` не меняется — его `INSERT OR IGNORE` для уже существующей
  строки просто не сработает, `UPDATE` (title/chatUsername) продолжит
  освежать эти два поля как раньше.

## Capabilities

### Modified Capabilities

- `join-queue`: успешное вступление дополнительно сразу создаёт/дополняет
  запись в `channels` с полной идентичностью канала и группы обсуждения,
  вместо ожидания следующего `syncChannels`/`cacheChannelIdentities`.

## Impact

- `src/core/telegram/service.ts` — `JoinResult` (новые поля), `joinDiscussionGroups`
  (сбор и возврат identity вместо отбрасывания).
- `src/core/db/channels.ts` — новая функция записи identity при вступлении.
- `src/skills/join-queue.ts` — вызов новой функции на `status==='joined'`.

## Non-Goals

- Не меняется существующий путь `syncChannels`/`cacheChannelIdentities` —
  он остаётся единственным источником для каналов, узнанных НЕ через
  `join-queue` (например, если агент был добавлен в группу вручную/другим
  способом).
- Не решается пункт 2 из сегодняшнего explore («banned-канал, назначенный
  агенту по новому распределению») — отдельный вопрос политики, не про
  данные вступления.
