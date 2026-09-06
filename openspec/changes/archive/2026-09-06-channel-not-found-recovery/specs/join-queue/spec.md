## MODIFIED Requirements

### Requirement: Ошибки при попытке вступления → error

При попытке вступления (поиск канала по username, получение информации о
канале, вступление — одна попытка, объединяющая три шага) ошибки
`USERNAME_NOT_OCCUPIED`, `USERNAME_INVALID`, `CHANNEL_PRIVATE`,
`CHANNEL_INVALID`, `INVITE_REQUEST_SENT`,
`INVITE_HASH_EXPIRED`, `INVITE_HASH_INVALID`, `USERS_TOO_MUCH` SHALL
переводить строку в `status='error'` с записью `errorMessage`.
`USER_BANNED_IN_CHANNEL`, возникший в контексте вступления, SHALL
обрабатываться на этой же ветке (`error`) — как и остальные ошибки этого
списка; отдельное поведение для него в контексте вступления не вводится.

`USER_ALREADY_PARTICIPANT` SHALL НЕ переводить строку в `error`: агент уже
является участником группы обсуждения, значит вступление достигло цели. Эта
ситуация SHALL трактоваться как успех (`status='joined'`) — см. Requirement
«`USER_ALREADY_PARTICIPANT` — путь восстановления строки канала».

#### Scenario: Постоянная причина отказа помечается error
- **WHEN** попытка вступления вернула `CHANNEL_PRIVATE`
- **THEN** строка получает `status='error'`, `errorMessage='CHANNEL_PRIVATE'`

#### Scenario: USER_BANNED_IN_CHANNEL при вступлении не меняет поведение
- **WHEN** попытка вступления вернула `USER_BANNED_IN_CHANNEL`
- **THEN** строка получает `status='error'` — то же поведение, что и для
  остальных ошибок этого Requirement, без выделения в отдельную ветку

#### Scenario: USER_ALREADY_PARTICIPANT больше не error
- **WHEN** попытка вступления вернула `USER_ALREADY_PARTICIPANT`
- **THEN** строка НЕ получает `status='error'` — обрабатывается как успешное вступление

### Requirement: Успешное вступление сразу заполняет identity канала в `channels`

При успешном вступлении (`join_queue.status='joined'`) система SHALL
создать (если строки ещё нет) или обновить (если строка уже существует)
запись в `channels` (tg-channels.db) полным набором идентичности, уже
резолвленной в процессе вступления: `chatId` (маркированный вид),
`title`, `chatAccessHash`, `chatUsername` (группы обсуждения) и
`channelId`, `channelAccessHash`, `channelUsername` (привязанного канала),
и SHALL установить `channelResolved = 1`. Это выполняется без ожидания
последующего `syncChannels`/`cacheChannelIdentities`.

Для уже существующей строки обновление SHALL быть полным: система SHALL
сбрасывать `status` в `null` (для ЛЮБОГО прежнего значения, включая
`banned`/`leaved_manual`/`not_found`), очищать `statusUpdatedAt`,
`statusDurationSeconds`, `status_description` и освежать `title`/`chatUsername`.
Повторное вступление означает, что агент снова участник, поэтому прежний статус
(в частности залипший `leaved_manual`) НЕ SHALL сохраняться. `lastProcessedAt`,
история визитов и метрики строки НЕ затрагиваются этим шагом.

#### Scenario: Новая строка создаётся сразу при вступлении

- **WHEN** `join-queue` успешно вступает в канал, для которого в `channels` ещё нет строки с этим `chatId`
- **THEN** строка создаётся немедленно, со всеми identity-полями, `channelResolved=1` и `status = null`, без ожидания следующего прогона монитора

#### Scenario: Существующая строка обновляется полностью со сбросом статуса

- **WHEN** `join-queue` успешно вступает в канал, для которого строка `channels` уже существует со `status = 'leaved_manual'`
- **THEN** identity-поля обновляются, `status` сбрасывается в `null`, `statusUpdatedAt`/`statusDurationSeconds`/`status_description` очищаются, а `lastProcessedAt` и метрики строки не изменяются

#### Scenario: `chatId` записывается в маркированном виде

- **WHEN** `join-queue` создаёт или обновляет строку `channels` при вступлении
- **THEN** `chatId` сохраняется в том же маркированном виде, что и в остальной системе (совпадает с `chatId` из `syncChannels`)

## ADDED Requirements

### Requirement: `USER_ALREADY_PARTICIPANT` — путь восстановления строки канала

Если при вступлении Telegram вернул `USER_ALREADY_PARTICIPANT`, система SHALL
трактовать это как успешное вступление: identity группы обсуждения и привязанного
канала уже резолвлены на шагах поиска канала и получения информации о нём (до
вызова вступления), поэтому система SHALL вернуть результат `status='joined'` с
этой identity и выполнить полный upsert строки `channels` (см. Requirement
«Успешное вступление сразу заполняет identity канала в `channels`»). Строка
`join_queue` получает `status='joined'`.

Это восстанавливает строку `channels`, ранее удалённую прежней логикой
`syncChannels`, для каналов, участником которых агент всё ещё является.

#### Scenario: Агент уже участник — строка канала восстанавливается
- **WHEN** попытка вступления вернула `USER_ALREADY_PARTICIPANT`, и строки `channels` для этого канала нет
- **THEN** строка `channels` создаётся полным upsert-ом со `status = null`, а строка `join_queue` получает `status='joined'`

#### Scenario: Агент уже участник, строка есть со статусом — статус сбрасывается
- **WHEN** попытка вступления вернула `USER_ALREADY_PARTICIPANT`, и строка `channels` существует со `status = 'not_found'`
- **THEN** `status` сбрасывается в `null`, identity освежается, `join_queue.status='joined'`
