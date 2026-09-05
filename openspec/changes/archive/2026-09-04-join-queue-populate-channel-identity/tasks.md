## 1. Telegram-слой (`src/core/telegram/service.ts`)

- [x] 1.1 Расширить `JoinResult` полями идентичности при `status='joined'`: `chatId` (маркированный, через `utils.getPeerId(discussionChat)`), `title`, `chatAccessHash`, `chatUsername`, `channelId`, `channelAccessHash`, `channelUsername` (все опциональные — присутствуют только при `status='joined'`).
- [x] 1.2 В `joinDiscussionGroups`: на успешном `JoinChannel` собрать эти поля из уже имеющихся `channel`/`discussionChat` и положить в `JoinResult`, вместо (или вместе с) существующего `discussionChatId`.
- [x] 1.3 Проверить импорт `utils` из GramJS в `service.ts` (уже используется — `utils.resolveId`, `utils.getPeerId` в другом месте) — переиспользовать, не дублировать импорт. Подтверждено: `utils` уже импортирован (`service.ts:10`), `getPeerId(peer: EntityLike, addMark?: boolean): string` принимает сущность напрямую.

## 2. БД-слой (`src/core/db/channels.ts`)

- [x] 2.1 Новая функция `upsertChannelIdentityFromJoin` — `INSERT ... ON CONFLICT(chatId) DO UPDATE SET` только identity-полей (`channelId`, `channelAccessHash`, `channelUsername`, `channelResolved=1`, `chatAccessHash`); при `INSERT` также `title`/`chatUsername`/`lastProcessedAt=0`. Не трогает `status`/`statusUpdatedAt`/`statusDurationSeconds`/`status_description` ни при `INSERT`, ни при `UPDATE`. Вызывает `initChannels` перед записью (первое обращение к `channels.db` агента может случиться раньше первого тика монитора).

## 3. Скилл (`src/skills/join-queue.ts`)

- [x] 3.1 На ветке `result.status === 'joined'` — вызывает `upsertChannelIdentityFromJoin` (если `result.identity` присутствует) до `updateJoinQueue(..., 'joined', ...)`.
