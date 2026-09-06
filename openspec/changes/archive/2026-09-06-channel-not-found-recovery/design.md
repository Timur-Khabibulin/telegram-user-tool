## Context

Диагностика по агентам с `monitor-v5` (см. proposal.md) выявила два дефекта
жизненного цикла строк `channels`:

- `upsertChannelIdentityFromJoin` (channels.ts) при повторном вступлении делает
  `ON CONFLICT(chatId) DO UPDATE` только по identity-полям, не трогая `status`.
  Итог — 198 строк залипли в `leaved_manual`, хотя `join_queue.updatedAt`
  (момент повторного `joined`) позже `statusUpdatedAt`.
- `syncChannels` (channels.ts) вычисляет `toRemove` (строки БД, которых нет в
  текущих диалогах Telegram) и делает по ним `DELETE`. Логика существует с init-
  коммита. Из-за неё пропали 498 каналов, для которых в `join_queue` есть
  `status='joined'`, но строки в `channels.db` нет.

Обе точки — в общем слое `src/core/db/channels.ts`; вступление также затрагивает
`src/core/telegram/service.ts` (`joinDiscussionGroups`) и
`src/skills/join-queue.ts` (`JOIN_ERROR_TAGS`). Сопоставление канал↔очередь в
диагностике делалось по `channelUsername`/`chatUsername` (в `join_queue` нет
`chatId`).

## Goals / Non-Goals

**Goals:**

- Повторное вступление снимает залипший статус — строка обновляется полностью,
  `status → null`.
- `USER_ALREADY_PARTICIPANT` восстанавливает потерянную строку `channels`, а не
  падает в `error`.
- Sync перестаёт безвозвратно удалять строки: активные пропавшие → `not_found`
  (обратимо), терминальные — не трогаются.
- Разовая миграция чистит накопленный мусор (cat4/cat5/cat7) на VPS.

**Non-Goals:**

- Периодическая перепроверка каналов, надолго залипших в `not_found` (реально
  мёртвых) — отдельная будущая работа.
- Изменение схемы БД: `channels.status` уже `TEXT`, новый статус не требует
  миграции колонок.
- Изменение логики отбора каналов дискавери/реестра (`discovery.db`) — не
  затрагивается.
- Ретро-восстановление истории визитов удалённых ранее строк — данные, стёртые
  прежним `DELETE`, не восстанавливаются (кроме повторного `joined`).

## Decisions

### D1. `USER_ALREADY_PARTICIPANT` обрабатывается в `joinDiscussionGroups` как успех

В `joinDiscussionGroups` identity (`channel` из `ResolveUsername`, `discussionChat`
из `GetFullChannel`) собирается ДО вызова `channels.JoinChannel`. Значит на момент
ошибки `USER_ALREADY_PARTICIPANT` вся identity уже известна. Решение — поймать
именно этот код в точке вызова `JoinChannel`, собрать тот же объект `identity`, что
и при обычном успехе, и вернуть `{ status:'joined', identity }`.

Альтернатива (отклонена): обрабатывать `USER_ALREADY_PARTICIPANT` в
`join-queue.ts` отдельной веткой, дорезолвливая identity повторным
`ResolveUsername`/`GetFullChannel`. Отклонено — лишний round-trip к Telegram и
дублирование логики резолва, тогда как identity уже на руках внутри
`joinDiscussionGroups`.

Следствие: `user_already_participant` убирается из `JOIN_ERROR_TAGS`
(join-queue.ts). Ветка `result.status === "joined"` естественно вызывает upsert.

### D2. Полный upsert строки при join, `status → null` всегда

`upsertChannelIdentityFromJoin` перестаёт быть «identity-only». `ON CONFLICT DO
UPDATE` расширяется: `status = NULL`, `statusUpdatedAt = NULL`,
`statusDurationSeconds = NULL`, `status_description = NULL`, плюс освежение
`title`/`chatUsername`. `lastProcessedAt`, `channel_visits`, метрики — не
трогаются (их нет в `INSERT ... ON CONFLICT`).

Сброс `status` безусловный (в т.ч. `banned`): факт успешного join означает, что
агент — участник, поэтому прежний терминальный статус неактуален. Альтернатива
(сохранять `banned`) отклонена — усложняет и противоречит наблюдаемому факту
членства.

### D3. `syncChannels`: `not_found` вместо `DELETE`, по текущему статусу

`toRemove` перестаёт делать `DELETE`. Для каждого пропавшего канала — ветвление по
текущему `status`:

- активный (`null`/`only_comment`/`sleep`/`format_error`) → `UPDATE status =
  'not_found', statusUpdatedAt = now()`;
- терминальный (`banned`/`suspend`/`leaved_*`/`should_leave`) → пропустить.

`toAdd`/`toUpdate` — без изменений. Дополнительно: среди «найденных» каналов, у
которых сейчас `status = 'not_found'`, sync снимает статус (`→ null`). Это требует,
чтобы `syncChannels` знал текущий `status` строки — сейчас он выбирает только
`title, chatUsername`; добавляется `status` в исходную выборку `dbChannels`.

Альтернатива (мягкое удаление отдельной колонкой `deleted_at`) отклонена —
плодит новое поле и ветвление во всех потребителях; `not_found` вписывается в уже
существующую модель `status` и её TTL-механику.

### D4. `not_found` в фильтрах потребителей

`getChannelsBatch` (channels.ts:371) и подсчёт активных (channels.ts:1471) —
добавить `'not_found'` в списки `NOT IN (...)`. `getLeaveQueue` и
`getPostWatchChannels` — не трогать (там allow-list / другой набор, `not_found`
исключается естественно). Тип `ChannelStatus` дополняется значением `not_found`.

### D5. Миграция — отдельный ops-скрипт, сопоставление как в диагностике

Разовый скрипт в `src/scripts/ops/` (по образцу существующих ops-скриптов),
обходит агентов с `monitor-v5 enabled=1` (`listAgentIds` + чтение `tasks.db`).
Сопоставление канал↔`join_queue` — по `channelUsername OR chatUsername` в пределах
БД одного агента (единственный доступный ключ; `chatId` в очереди нет). Три
действия идемпотентны и логируют затронутые строки:

- cat4: `UPDATE channels SET status=NULL, statusUpdatedAt=NULL, ... WHERE
  status='leaved_manual' AND statusUpdatedAt < joined_at`;
- cat5: `... WHERE status='only_comment'` и нет сопоставленной `joined`-записи;
- cat7: `UPDATE join_queue SET status='pending', updatedAt=now() WHERE
  status='joined'` и нет строки `channels` для этого username.

## Risks / Trade-offs

- **[Порядок деплоя]** Если миграцию (cat7 → pending) запустить до выката кода,
  повторные вступления упрутся в старый `user_already_participant → error` и строки
  не восстановятся. → Митигация: жёсткий порядок «код → миграция», зафиксирован в
  tasks.md; скрипт запускается вручную оператором после подтверждения деплоя.
- **[Накопление строк]** Sync больше не удаляет — терминальные и `not_found`
  строки живут вечно, `channels.db` растёт. → Приемлемо: строк на агента немного
  (сотни), сохранение истории/метрик — сознательная цель. Чистка мёртвых
  `not_found` — отдельная будущая работа (Non-Goal).
- **[Сопоставление по username]** cat4/cat5/cat7 матчатся по username, не по
  `chatId` — возможны единичные расхождения (канал без `channelUsername`). → Уже
  наблюдалось (1 из 199 cat4 ушёл в cat5). Приемлемо для разовой миграции; логика
  вперёд опирается на `chatId` и не страдает.
- **[Сброс `banned` при join]** Теоретически можно повторно вступить в канал,
  который забанит на отправке снова. → Не проблема: следующий монитор-прогон опять
  проставит `banned` штатно; данные не теряются.
- **[`not_found` на живом канале]** Если пропажа из диалогов — артефакт неполного
  листинга (а не реального выхода), `not_found` встанет на живой канал. →
  Обратимость (D3): следующий sync, где канал появился, снимет `not_found`; recovery
  через `USER_ALREADY_PARTICIPANT` (D1) страхует случай, когда канал ушёл в очередь
  на повторное вступление.

## Migration Plan

1. Выкатить код (D1–D4) на VPS обычным деплоем `src/`.
2. Проверить прогон `join-queue` и `monitor-v5` на одном-двух агентах — что
   `USER_ALREADY_PARTICIPANT` даёт `joined`, а sync не удаляет.
3. Запустить ops-скрипт миграции (D5) на всех `monitor-v5`-агентах.
4. Сверить воронку: рост активных (`status=null`) к ~1083 по мере отработки
   `join-queue` по переведённым в `pending` записям.

Откат: код — обычный revert (строки, ставшие `not_found`/`null`, останутся, но это
не ломает старую логику — `syncChannels` старой версии просто удалит `not_found`
строки при следующем sync). Миграция необратима по данным (статусы уже сброшены),
но не деструктивна — сброс в `null`/`pending` восстановим повторным прогоном
логики.

## Open Questions

- Нет. Все спорные точки закрыты на этапе explore (обработка
  `USER_ALREADY_PARTICIPANT`, судьба `only_comment` в cat5, обратимость
  `not_found`, целевое число 1083).
