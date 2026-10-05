## Context

Полный дизайн и эмпирика — `docs/design/tg-peer-identity-model/architecture.md` §9
(парный к нему `requirements-v1.md`). Здесь конспект; за деталями к §9, не дублировать.
Поверх реализованного `tg-peer-identity-model` (провенанс `access_hash`:
`chat_access_hash_updated_at` vs `sessionAuthorizedAt`, `getFreshChatAccessHash`,
`accessHashFresh`, `membership`).

## Goals / Non-Goals

**Goals:**
- Убрать суточный таймер полного синка; держать `access_hash` свежим по событию
  (устаревание относительно авторизации), а не по расписанию.
- Детектить `not_found` своевременно в момент чтения, без периодического обхода.
- Когерентность предикатов свежести для legacy (бэкафилл `sessionAuthorizedAt`).

**Non-Goals:**
- Нормативная обработка каналов монитором (group-monitoring-v5) — не меняется.
- Миграция basic_group→супергруппа (группа 6 tg-peer-identity-model) — отдельно.
- Провенанс `channelAccessHash` привязанного broadcast (post-watch/метрики вне скоупа).

## Decisions

1. **Триггер по устареванию вместо таймера** (§9.2). `hasStaleAccessHashes(agentId,
   sessionAuthorizedAt)` заменяет `isFullSyncDue`. Причина: после reauth все хэши
   устаревают → один проход heal'ит; между reauth ничего не устаревает → проход не
   нужен. Предикат строго `membership='member'` — иначе not_found/left с пустым хэшем
   триггерят проход вечно.
2. **Read-time not_found через `catch CHANNEL_PRIVATE`** (§9.3, эмпирика OV-9.1).
   Не-участник с валидным хэшем → `CHANNEL_PRIVATE` (throw) на `getPeerDialog`/
   `getMessages`. Помечаем `not_found`. Подтверждающий пробинг `getMessages(limit=1)`
   отвергнут — не нужен: `[]` для не-участника не возвращается, throw достоверен.
3. **Гейт `CHANNEL_PRIVATE` vs `CHANNEL_INVALID`.** Первый (валидный хэш, не участник)
   → `not_found`; второй (протухший хэш) → инвалидация + reacquire (§3.3). Корректно
   по построению: сидируем только свежий хэш.
4. **Бэкафилл `sessionAuthorizedAt = now`** во все `tg-account.json` при внедрении.
   Без него у legacy предикаты не определены. Разовый thundering-herd (все агенты на
   первом прогоне сделают один проход) — размазан диспетчером.

## Risks / Trade-offs

- [Потеря автодискавери каналов, в которые вступили мимо join-queue] → джойны идут
  через join-queue (`upsertChannelIdentityFromJoin`); ручные/ops-джойны редки. Приемлемо.
- [Залипший `not_found` (агент снова участник)] → снимается `clearNotFoundStmt` в
  полном проходе или `upsertChannelIdentityFromJoin` при re-join. Не блокер (§9.3).
- [Thundering-herd на первом прогоне после бэкафилла] → разовый, размазан диспетчером.

## Migration Plan

1. Реализовать `hasStaleAccessHashes`, переключить триггер в monitor-v5, read-time
   not_found, удалить таймерные артефакты.
2. Разовый бэкафилл `sessionAuthorizedAt = now` в существующие `tg-account.json` при
   деплое (скрипт/ops-шаг). Идемпотентно.
3. Откат: восстановить таймерный триггер (код) — данные аддитивны, вреда нет.

## Open Questions

Нет — OV-9.1/OV-9.2 разрешены эмпирически (architecture.md §9.6, проверено на живом
агенте agent121).
