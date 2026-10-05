## 1. Триггер полного прохода по устареванию

- [x] 1.1 `channels.ts`: `hasStaleAccessHashes(agentId, sessionAuthorizedAt, log)` — EXISTS канал `membership='member'` И (`chat_access_hash_updated_at IS NULL OR < sessionAuthorizedAt`); при `sessionAuthorizedAt == null` → false
- [x] 1.2 `monitor-v5.ts` Шаг 3: `isFullSyncDue(...)` → `hasStaleAccessHashes(agentId, tg.getAccountConfig().sessionAuthorizedAt, log)`; блок прохода не изменён
- [x] 1.3 Удалены таймерные артефакты: `isFullSyncDue`/`markFullSyncDone`/`sync_state` (channels.ts), `V5_FULL_SYNC_PERIOD_SECONDS` (config.ts), их импорты/вызовы в monitor-v5 + шапка-комментарий

## 2. Read-time детект not_found

- [x] 2.1 `monitor-v5.ts` `catch` вокруг `getPeerDialog`: тег `channel_private` → `markChannelStatus(not_found)` + `recordChannelVisit(empty)` + `continue`. `CHANNEL_INVALID`/`PEER_ID_INVALID` НЕ сюда (протухший хэш)
- [x] 2.2 Пути reply (`handlePostCommentSendError`) и чтения (`getMessages` catch) — тот же классификатор: `channel_private` → `not_found`
- [x] 2.3 null-результат `getPeerDialog` оставлен как `dialog_status_unknown` skip (не not_found)

## 3. Бэкафилл sessionAuthorizedAt

- [x] 3.1 Ops-скрипт `src/scripts/ops/backfill-session-authorized-at.ts` — `sessionAuthorizedAt = now` где нет; идемпотентно, `--agents`/`--force`
- [x] 3.2 Thundering-herd задокументирован в шапке скрипта и design.md

## 4. Проверка

- [x] 4.1 Типизация: новых ошибок tsc в затронутых файлах нет (предсуществующие better-sqlite3/bigint — не наши)
- [x] 4.2 Локальный прогон на SQLite: `hasStaleAccessHashes` — member свежий→не stale; member null/старый→stale; not_found/left не считаются; undefined auth→false. 5/5 assert
- [x] 4.3 Сверка со спекой (логика правок): after reauth один проход heal'ит; между reauth прохода нет; `CHANNEL_PRIVATE`→not_found; `CHANNEL_INVALID`→reacquire
- [x] 4.4 На VPS (после деплоя): кикнутый канал → not_found на ближайшем чтении (требует деплоя, вне локального прогона)
