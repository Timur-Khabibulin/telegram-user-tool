## 1. Статус `not_found` и фильтры потребителей

- [x] 1.1 Добавить `'not_found'` в тип `ChannelStatus` (src/core/db/channels.ts)
- [x] 1.2 Добавить `'not_found'` в исключающий список `getChannelsBatch` (channels.ts:371)
- [x] 1.3 Добавить `'not_found'` в исключающий список подсчёта активных каналов (channels.ts:1471)
- [x] 1.4 Проверить, что `getLeaveQueue` и `getPostWatchChannels` не требуют правок (`not_found` исключается естественно)

## 2. Sync без удаления (D3)

- [x] 2.1 В `syncChannels` добавить `status` в выборку `dbChannels` (сейчас только `title, chatUsername`)
- [x] 2.2 Заменить `DELETE` по `toRemove` на: активный статус (`null`/`only_comment`/`sleep`/`format_error`) → `UPDATE status='not_found', statusUpdatedAt=now()`; терминальный — пропустить
- [x] 2.3 Добавить снятие `not_found` для найденных каналов: `status='not_found'` среди присутствующих в диалогах → `UPDATE status=NULL`
- [x] 2.4 Обновить лог `syncChannels` (вместо `removed` — счётчики `markedNotFound`/`clearedNotFound`)

## 3. Join self-heal (D1, D2)

- [x] 3.1 В `joinDiscussionGroups` (src/core/telegram/service.ts) ловить `USER_ALREADY_PARTICIPANT` в точке вызова `JoinChannel` и возвращать `{ status:'joined', identity }` с уже собранной identity
- [x] 3.2 Убрать `'user_already_participant'` из `JOIN_ERROR_TAGS` (src/skills/join-queue.ts)
- [x] 3.3 Расширить `upsertChannelIdentityFromJoin` (channels.ts): `ON CONFLICT DO UPDATE` сбрасывает `status`/`statusUpdatedAt`/`statusDurationSeconds`/`status_description` в NULL и освежает `title`/`chatUsername`; `lastProcessedAt`/метрики не трогать

## 5. Разовая миграция БД (D5) — ТОЛЬКО после деплоя кода

- [x] 5.1 Написать ops-скрипт `src/scripts/ops/channel-not-found-migration.ts`: обход агентов с `monitor-v5 enabled=1`, сопоставление канал↔`join_queue` по `channelUsername OR chatUsername` в пределах агента, идемпотентно, с логом затронутых строк
- [x] 5.2 cat4: `channels.status='leaved_manual'` где `statusUpdatedAt < joined_at` → `status=NULL` (+ очистка `statusUpdatedAt`/duration/description)
- [x] 5.3 cat5: `channels.status='only_comment'` без сопоставленной `joined`-записи → `status=NULL`; остальные статусы cat5 не трогать
- [x] 5.4 cat7: `join_queue.status='joined'` без строки `channels` для этого username → `status='pending'`, `updatedAt=now()`
- [x] 5.5 Прогон миграции на VPS ПОСЛЕ подтверждения деплоя кода (порядок критичен — см. design.md D5/Risks)
- [x] 5.6 Сверить воронку после отработки `join-queue`: рост активных (`status=null`) в сторону ~1083 — немедленный срез: 587 активных (328 базовых + 257 cat4/cat5, сходится); 508 в `join_queue.status='pending'` (498 requeued cat7 + фоновый бэклог) дойдут до ~1083 по мере плановых прогонов `join-queue` (не мгновенно)

## 6. Документация

- [x] 6.1 Обновить docs (telegram-errors.md — `USER_ALREADY_PARTICIPANT` больше не error; db-schema/architecture не перечисляют конкретные значения status — правка не требуется)
