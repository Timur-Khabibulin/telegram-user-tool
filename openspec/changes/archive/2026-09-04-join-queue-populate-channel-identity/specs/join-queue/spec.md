## ADDED Requirements

### Requirement: Успешное вступление сразу заполняет identity канала в `channels`

При успешном вступлении (`join_queue.status='joined'`) система SHALL
создать (если строки ещё нет) или дополнить (если строка уже существует)
запись в `channels` (tg-channels.db) полным набором идентичности, уже
резолвленной в процессе вступления: `chatId` (маркированный вид),
`title`, `chatAccessHash`, `chatUsername` (группы обсуждения) и
`channelId`, `channelAccessHash`, `channelUsername` (привязанного канала),
и SHALL установить `channelResolved = 1`. Это выполняется без ожидания
последующего `syncChannels`/`cacheChannelIdentities`.

#### Scenario: Новая строка создаётся сразу при вступлении

- **WHEN** `join-queue` успешно вступает в канал, для которого в `channels` ещё нет строки с этим `chatId`
- **THEN** строка создаётся немедленно, со всеми identity-полями и `channelResolved=1`, без ожидания следующего прогона монитора

#### Scenario: Существующая строка дозаполняется, не перезаписывая `status`

- **WHEN** `join-queue` успешно вступает в канал, для которого строка `channels` уже существует (создана параллельным `syncChannels`)
- **THEN** identity-поля (`channelId`/`channelAccessHash`/`channelUsername`/`channelResolved`/`chatAccessHash`) дозаполняются, а `status`/`lastProcessedAt`/`title`/`chatUsername` этой строки не изменяются этим шагом

#### Scenario: `chatId` записывается в маркированном виде

- **WHEN** `join-queue` пишет `chatId` новой или существующей строки
- **THEN** значение — маркированный вид (`-100…`, через `utils.getPeerId`), совпадающий с форматом, который использует `syncChannels`

#### Scenario: Уже резолвленный канал не попадает на повторный резолв

- **WHEN** канал получил `channelResolved=1` через вступление в `join-queue`
- **THEN** он не попадает в выборку `getUnresolvedChats`/`cacheChannelIdentities` — повторного `GetFullChannel` для него не происходит
