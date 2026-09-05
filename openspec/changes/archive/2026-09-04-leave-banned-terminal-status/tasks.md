## 1. Модель данных (`src/core/db/channels.ts`)

- [x] 1.1 Добавить `"leaved_from_banned"` и `"leaved_manual"` в тип `ChannelStatus`.
- [x] 1.2 `getLeaveQueue`: расширить `LeaveQueueRow` полем `status: 'banned' | 'should_leave'`, добавить в `SELECT`.
- [x] 1.3 Заменить `resetChannelStatus(agentId, chatId, log)` на функцию с параметром целевого статуса, например `setLeftChannelStatus(agentId, chatId, status: 'leaved_from_banned' | 'leaved_manual', log)`: `status` = переданное значение, `statusUpdatedAt` = текущее время, `statusDurationSeconds`/`status_description` = `NULL`.
- [x] 1.4 `getChannelsBatch`: добавить `'leaved_from_banned'`, `'leaved_manual'` в blocklist рядом с `'banned'`/`'suspend'`.
- [x] 1.5 Проверить `getPostWatchChannels` — подтвердить (без изменения кода), что allowlist уже исключает новые статусы.

## 2. Скилл (`src/skills/leave-banned-channels.ts`)

- [x] 2.1 После успешного `purgeChannelData` вызывать новую функцию (задача 1.3) с терминальным статусом, вычисленным из `queue[idx].status` (`'banned'` → `'leaved_from_banned'`, `'should_leave'` → `'leaved_manual'`).
- [x] 2.2 Убедиться, что при ошибке `leaveChannel` статус не трогается (уже так, проверено — `continue` в catch пропускает и чистку, и установку статуса).

## 3. Документация

- [x] 3.1 Обновить список значений `ChannelStatus` в комментариях `src/core/db/channels.ts`, где он перечисляется явно.
- [x] 3.2 `docs/telegram-errors.md` — точечно обновлена устаревшая ячейка `channels.status='banned'` (ссылка на актуальное поведение), полная сверка документа вне скоупа (уже была вынесена за скоуп в `leave-banned-human-pacing`).

## 4. Миграция для 46 агентов (разовая, не переиспользуемая способность)

Список агентов (тот же, что получил сегодняшнее перераспределение каналов):
`agent10, agent18, agent22, agent28, agent30, agent36, agent39, agent41, agent42, agent45, agent121, agent122, agent125, agent127, agent128, agent131, agent138, agent143, agent145, agent146, agent155, agent157, agent158, agent159, agent160, agent161, agent163, agent172, agent175, agent177, agent182, agent185, agent188, agent194, agent196, agent197, agent198, agent199, agent200, agent202, agent204, agent205, agent207, agent208, agent209, agent211`.

- [x] 4.1 Написать разовый скрипт (`src/scripts/mark-should-leave-reassigned.ts`) со списком агентов, зашитым в файле (по прецеденту `activate-leave-banned-for-agents.ts`).
- [x] 4.2 Для каждого агента: прочитать `channels.channelUsername` (tg-channels.db) и `join_queue.link` (tg-join-queue.db), нормализовать оба через `normalizeChannelLink`. Канал со `status IS NULL` и `channelResolved=1` помечается `should_leave`, если нормализованный `channelUsername` не входит в множество нормализованных `join_queue.link` (или `channelUsername IS NULL` — группа без привязанного канала, по определению не может быть в `join_queue`). Каналы `channelResolved=0` (идентичность ещё не резолвлена) и каналы с уже другим не-`NULL` статусом — не трогать.
  - **Инцидент во время apply**: первая версия сравнивала `channels.chatUsername` (username самого чата обсуждения) вместо `channels.channelUsername` (username привязанного канала) — join-queue вступает именно в группу обсуждения (`joinDiscussionGroups`), поэтому после вступления совпадает с `join_queue.link` именно `channelUsername`, не `chatUsername`. Ошибка дала 0 совпадений на всех 46 агентах и лишние 227 пометок `should_leave`. Обнаружено пользователем, поле исправлено на `channelUsername`.
  - **Последствие**: до обнаружения бага `leave-banned` успел реально покинуть (не только в БД, физический MTProto-выход) 204 из этих 227 ошибочно помеченных каналов. Откат статуса в БД (`should_leave` → `NULL`) не восстанавливает Telegram-членство — эти 204 канала переставлены обратно в `join_queue.status='pending'` (по всем 46 агентам, где встретились) для повторного вступления через штатную задачу `join-queue`.
- [x] 4.3 Прогнать скрипт на VPS, залогировать по каждому агенту: сколько каналов помечено `should_leave`, сколько пропущено. Итоги по прогонам: первый (с багом, `chatUsername`) — 323; второй (тоже с багом, но с исправлением приватных каналов) — 1452 суммарно; после отката 227 ошибочных и повторного прогона с исправленным полем (`channelUsername`) — итоговое устойчивое состояние подтверждено нулём расхождений (`should_leave`/`leaved_manual` не пересекается с `join_queue`).
- [x] 4.4 Включить задачу `leave-banned` тем из 46 агентов, у кого `enabled=0` или строки ещё нет — у всех 46 уже была `enabled=1`, действий не потребовалось. Отдельно (не входит в исходный скоуп задачи, но нужно для того же списка) включена `join-queue` у оставшихся 7 агентов, где её не было (`agent36`, `agent39`, `agent155`, `agent175`, `agent204`, `agent209`, `agent211`) — с сохранением уже назначенного расписания.
- [x] 4.5 Скрипт `mark-should-leave-reassigned.ts` удалён из репозитория и с VPS после использования — решение пользователя пересмотрело прецедент `activate-leave-banned-for-agents.ts` (тот скрипт не удалялся), для этой миграции решили не оставлять.

