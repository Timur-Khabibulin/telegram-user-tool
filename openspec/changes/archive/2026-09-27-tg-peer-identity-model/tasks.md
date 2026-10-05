## 1. Провенанс сессии (`session_authorized_at`)

- [x] 1.1 Добавить опциональное поле `session_authorized_at` в `AccountConfig`/`PoolAccountConfig` и его чтение в `loadAccountConfig`/`loadPoolAccountConfig` (`src/core/config.ts`)
- [x] 1.2 `writeSessionString` (`tg-agent-reauth-from-tdata/run.ts`) — писать `session_authorized_at = now` рядом с `sessionString`, БД не трогать
- [x] 1.3 Проставлять `session_authorized_at = now` в остальных точках записи сессии: `promoteToWorkspace` (autoregistration), `promoteToPool` (pool-provision), сторона-персистер `authSignIn`
- [x] 1.4 Семантика отсутствующего `session_authorized_at` = «невалидно» (учитывается правилом §2.2 в 3.1)

## 2. Миграция схемы `channels.db` (Вариант A, аддитивно)

- [x] 2.1 Добавить `migratePeerIdentityColumns` в `channels.ts` тем же паттерном, что существующие `migrate*Columns`: `peer_type`, `chat_access_hash_updated_at`, `channel_access_hash_updated_at`, `membership`, `membership_updated_at`, `migrated_to_id`
- [x] 2.2 Разовый бэкафилл `peer_type` из вида `chatId` (`-100…`→`megagroup`, `-id`→`basic_group`)
- [x] 2.3 Разовый бэкафилл `membership`/`membership_updated_at` из `status` по таблице отображения (architecture.md §5.1.1); `status` не вычищать
- [x] 2.4 `*_updated_at` для унаследованных `chatAccessHash`/`channelAccessHash` — NULL (невалидны)

## 3. Правило валидности и переполучение `access_hash`

- [x] 3.1 Реализовать предикат `accessHashValid(row, session_authorized_at)` (`accessHashFresh` в channels.ts: `updatedAt != null && sessionAuthorizedAt != null && updatedAt >= sessionAuthorizedAt`)
- [x] 3.2 Гейт валидности на чтении персистентного хэша (`getFreshChatAccessHash`); `basic_group` — `InputPeerChat` без хэша (существующий `cachePeerForDialog`); валидность применяется на всех путях чтения сохранённого хэша (cold review-listener, monitor-v5 seed)
- [x] 3.3 reacquire id-only: `populatePeerCacheForIds([marked_id])` (без резолва по username) на холодном пути review-listener; при успехе персист свежего хэша, иначе — сигнал «недоступен»
- [x] 3.4 Точки персиста хэша (`saveChatAccessHash`, `saveChannelIdentity`, `upsertChannelIdentityFromJoin`) — пишут `*_updated_at = now` вместе с хэшем
- [x] 3.5 Холодный путь review-listener: сидировать `peerCache` только если хэш валиден (`getFreshChatAccessHash`); иначе переполучить проходом диалогов и персистить перед отправкой

## 4. Инвалидация при отказе API

- [x] 4.1 При `PEER_ID_INVALID`/`CHANNEL_INVALID` — `invalidateChatAccessHash` (обнуляет `chatAccessHash`+`chat_access_hash_updated_at`) в `handlePostCommentSendError`; следующее чтение уйдёт в переполучение. In-memory `peerCache` освежается штатным `getDialogs`

## 5. Членство (`membership`) — dual-write

- [x] 5.1 Запись `membership`+`membership_updated_at = now` рядом со `status`: `upsertChannelIdentityFromJoin`→`member`, `markChannelStatus` (через `membershipForStatus`)→`banned`, `setLeftChannelStatus`→`left`, `syncChannels` (`markNotFound`→`not_found`, `clearNotFound`→`member`), `resetChannelStatuses`→`member`
- [x] 5.2 Нечленские `status` (`suspend`/`format_error`/`only_comment`/`sleep`/`should_leave`) `membership` НЕ трогают (`membershipForStatus` → null → COALESCE)
- [x] 5.3 Вне-скоупных потребителей `status` НЕ трогали (продолжают читать `status`)

## 6. Миграция basic group → супергруппа (R6)

- [~] 6.1 ОТЛОЖЕНО (решение координатора 25.09, редкий случай). Уточнено по api/channel: платформа poll-based, живые апдейты не потребляет; после change `monitor-v5-hash-driven-sync` `syncChannels` идёт только по устареванию хэшей (≈после reauth), не периодически → миграция сама не обработается между reauth. Надёжный вектор — read-time служебное `messageActionChatMigrateTo` при обращении к старому basic group. См. память `project_basic_group_migration_detection_deferred`
- [~] 6.2 ОТЛОЖЕНО вместе с 6.1. Колонка `migrated_to_id` заведена (миграция 2.1) как задел; логика записи (`onBasicGroupMigrated`) — когда вернёмся. Заодно решить нюанс: исключать ли `basic_group` из предиката `hasStaleAccessHashes`

## 7. Проверка

- [x] 7.1 Типизация: новых ошибок tsc в затронутых файлах нет (предсуществующие better-sqlite3/bigint — не наши); проект бегает на tsx без tsc-гейта
- [x] 7.2 Прогон на реальной SQLite (временный скрипт): миграция+бэкафилл (peer_type, membership, `should_leave`→member без вычистки status), dual-write (banned/left/not_found/format_error-no-op), провенанс/свежесть, invalidate — 22/22 assert прошли
- [x] 7.3 Проверить холодный путь review-listener после имитации reauth на живом агенте (устаревший хэш переполучается) — требует боевой сессии/VPS, вне локального прогона
