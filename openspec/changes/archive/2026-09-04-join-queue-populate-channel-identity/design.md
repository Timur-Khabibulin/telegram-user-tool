## Context

`joinDiscussionGroups` (`service.ts:1307`) на успешном пути уже резолвил всё
нужное к моменту `JoinChannel`:

```
ResolveUsername(username)           → channel: Api.Channel (id, accessHash, username)
GetFullChannel(channel)              → fullChat.linkedChatId
                                        chats[] содержит discussionChat: Api.Channel
                                        (id, accessHash, username, title)
JoinChannel(discussionChat)          → вступление выполнено
```

Всё это выбрасывается — наружу возвращается только `{ link, status: "joined",
discussionChatId }` (`JoinResult`, `service.ts:58`).

`channels`-строка появляется позже, через `syncChannels()` (только `chatId`/
`title`/`chatUsername`, из высокоуровневого `Dialog.id` — уже маркированный),
и ещё позже `channelId`/`channelAccessHash`/`channelUsername` — через
`cacheChannelIdentities()` → `resolveChannelIdentityForDialog` →
`resolveLinkedBroadcast`, которая делает **свой** `GetFullChannel` от группы к
каналу — второй сетевой запрос за тот же факт.

`chatId` в `channels` — маркированный вид (`-100…`): так пишет `syncChannels`
(источник — `Dialog.id`), так читают все `WHERE chatId = ?` по кодовой базе.
`discussionChat.id` (сырой `Api.Channel.id` из `GetFullChannel.chats`) —
**не** маркирован. Кодовая база уже придерживается правила «не изобретать
свою арифметику `-100`-префикса» (`service.ts:696`, коммент к
`utils.resolveId`) — обратная операция (маркировка) должна идти через
`utils.getPeerId()`, ту же GramJS-утилиту, что уже используется в другом
месте файла (`service.ts:1826`).

## Goals / Non-Goals

**Goals:**
- Строка `channels` для канала, полученного через `join-queue`, появляется
  сразу при успешном вступлении, с полным набором identity-полей и
  `channelResolved=1` — без ожидания следующего `syncChannels`/
  `cacheChannelIdentities`.
- `chatId` записывается в том же маркированном формате, что и везде.
- Устраняется повторный `GetFullChannel` для каналов, вступление в которые
  уже прошло через `join-queue`.

**Non-Goals:**
- Не трогается путь для каналов, узнанных НЕ через `join-queue` (ручное
  добавление агента в группу и т.п.) — там `syncChannels`/
  `cacheChannelIdentities` остаются единственным источником.
- Не меняется формат/поведение `syncChannels` — он продолжает освежать
  `title`/`chatUsername` при каждом синке, даже для строк, уже заполненных
  этим change.

## Decisions

### Decision 1 — Идентичность возвращается через `JoinResult`, не пишется внутри `service.ts`

`service.ts` (core/telegram) не знает о БД — запись в `channels` делает
`join-queue.ts` (core/db). Поэтому `joinDiscussionGroups` только **возвращает**
собранные данные в расширенном `JoinResult`, а не пишет сама. Сохраняет
существующее разделение ответственности (Telegram-слой / БД-слой), видимое
по всей кодовой базе.

### Decision 2 — `chatId` через `utils.getPeerId(discussionChat)`

Единственный способ получить корректный маркированный ID из `Api.Channel`-сущности,
не наткнувшись на рассинхрон с `syncChannels`. Альтернатива (ручной
`-100` + raw id) отклонена — кодовая база явно декларирует отказ от
самодельной арифметики маркировки.

### Decision 3 — Запись idempotent, дозаполняет частично существующую строку

Между вступлением и записью может успеть сработать `syncChannels` того же
или другого тика (гонка маловероятна, но не исключена — оба пишут в один
файл БД, но разными вызовами не в одной транзакции). Функция записи делает
`INSERT ... ON CONFLICT(chatId) DO UPDATE SET` для identity-полей
(`channelId`/`channelAccessHash`/`channelUsername`/`channelResolved`/
`chatAccessHash`), не трогая `status`/`lastProcessedAt`/`title`/`chatUsername`
при конфликте (эти поля already-authoritative из `syncChannels`, если строка
уже была).

### Decision 4 — `cacheChannelIdentities` не меняется

Она уже фильтрует по `channelResolved = 0` (`getUnresolvedChats`) — как
только новая функция проставляет `channelResolved=1`, эти чаты сами выпадают
из её выборки. Никакой явной координации между двумя механизмами не
требуется.

## Migration Plan

Не требуется — новая логика применяется только к будущим вступлениям через
`join-queue`. Уже существующие строки `channels` (заполненные через старый
путь) не трогаются; при желании их можно дозаполнить будущим прогоном
`cacheChannelIdentities` как и раньше (не меняется).

## Open Questions

- Стоит ли аналогично сократить путь для `resolveChannelByUsername`
  (используется другими скиллами, не `join-queue`) — вне скоупа, отдельный
  вопрос, если всплывёт похожая избыточность.
