---
name: tg-peer-identity-model-architecture
description: Дизайн модели идентичности peer (access_hash-инвалидация по таймстампам); ключевые нетривиальные факты кода
metadata:
  type: project
---

Архитектура `docs/design/tg-peer-identity-model/architecture.md` (парная к
`requirements-v1.md`, R1–R6). Согласованный механизм: `access_hash` валиден ⟺
`access_hash IS NOT NULL AND access_hash_updated_at >= session_authorized_at`;
`session_authorized_at` живёт в `tg-account.json` (не в БД), `access_hash_updated_at`
— в БД. Reauth пишет `session_authorized_at=now` и НЕ трогает `channels.db`.

- **reacquire (§3.2) — id-only.** Переполучение `access_hash` строго через
  `populatePeerCacheForIds([marked_id])` (проход диалогов = «encounter»), БЕЗ
  ResolveUsername. Причины: (1) хэш нельзя получить из голого id никаким RPC,
  только encounter; GramJS StringSession не персистит entity-кэш (ADR-0003);
  (2) reacquire-peer — всегда тот, где агент состоит → проход диалогов вернёт
  хэш и для приватных без username; (3) снимает риск перехвата username
  (id стабилен, username изменяем). ResolveUsername остаётся ТОЛЬКО для join
  ещё не встреченного peer (§3.6).
- **§9 (стратегия синка monitor-v5) — спроектирована.** Суточный таймер
  (V5_FULL_SYNC_PERIOD_SECONDS/isFullSyncDue/markFullSyncDone/sync_state) убрать;
  полный проход триггерить по `hasStaleAccessHashes(agentId, sessionAuthorizedAt)`
  = EXISTS member-канал с chat_access_hash_updated_at NULL/< sessionAuthorizedAt
  (фильтр membership='member' ОБЯЗАТЕЛЕН, иначе not_found/left вечно устаревшие).
  not_found теперь ставит ТОЛЬКО syncChannels (406 каналов по флоту) — заменяется
  read-time детектом (Вариант A). ЭМПИРИКА (agent121, боевые): не-участник с
  валидным хэшем → GetPeerDialogs/GetHistory БРОСАЮТ CHANNEL_PRIVATE (не []);
  участник → возвращается диалог. Поэтому детект = ТОЛЬКО catch CHANNEL_PRIVATE
  вокруг getPeerDialog (пробинг getMessages УБРАН, не нужен). Гейт: CHANNEL_PRIVATE
  при свежем засеянном хэше→not_found; CHANNEL_INVALID/PEER_ID_INVALID→протухший
  хэш→reacquire §3.3; null (запрос не ушёл — нет свежего хэша в кэше)→
  dialog_status_unknown skip, НЕ not_found. Точка правки — catch на getPeerDialog
  (getMessages/reply бросают тот же CHANNEL_PRIVATE, тот же классификатор).
  not_found в БД БЫВАЕТ ЗАЛИПШИМ (агент снова участник) — снимается clearNotFoundStmt
  (полный проход) или upsertChannelIdentityFromJoin (re-join). Обязателен разовый
  бэкафилл sessionAuthorizedAt=now (thundering-herd на первом прогоне). OV-9.1/9.2
  закрыты эмпирически (архивных диалогов у агента 0 — кейс архива неактуален).
- **username first-class для join/идентификации, не для reacquire (§3.6).**
  `linked_broadcast_username` (← существующий `channelUsername`) — основной
  публичный хэндл (join идёт через канал: ResolveUsername→GetFullChannel→
  linkedChat); `username` обсуждения (← `chatUsername`, обычно NULL) — вторичный.
  channelUsername больше НЕ «вне скоупа», это first-class identity-атрибут;
  отдельной новой колонки не заводим.

Нетривиальные факты кода, вскрытые при проектировании (проверять перед реализацией):

- **Старую per-account `channels.db` при замене аккаунта уничтожает
  `commitSwap`** (`swap.ts:132`, удаление `.old`), а НЕ `buildIncoming`
  (тот чистит только `.incoming` из пула, где channels.db и так нет; `WORKING_DBS`
  swap.ts:22 — подстраховка). AC-3 закрыт как «корректно»: закрепление канала за
  агентом живёт в реестре `discovery.db` и переживает замену через
  `listAgentAssignmentLinks`→`addJoinQueue` (`banned-account-replacement/run.ts:214-217`);
  per-account сведения (access_hash, membership) сбрасываются и восстанавливаются
  re-join. `tasks.db` переносится, чистится только таблица `tasks`.
- **O-4 РЕШЕНО: `membership` — новое поле** (member/left/banned/not_found) +
  `membership_updated_at`, целевой дом факта членства. **R-1 РЕШЕНО как
  dual-write**: миграция ТОЛЬКО популирует membership из status (derive), status
  НЕ вычищает; членский факт пишется РЯДОМ в оба поля на существующих сайтах
  записи (dual-write), потребители продолжают читать status без изменений.
  Сайты dual-write (все в channels.ts): upsertChannelIdentityFromJoin→member,
  markChannelStatus при 'banned'→banned (для suspend/format_error/only_comment/sleep
  membership НЕ трогаем), setLeftChannelStatus→left, syncChannels markNotFound→not_found /
  clearNotFound→member, resetChannelStatuses→member. Перевод потребителей на
  membership + вычистка status — ОТДЕЛЬНЫЙ будущий change (план сходимости:
  сначала перевести всех читателей, потом чистить status).
  **should_leave остаётся в status** (pending-действие, не членство): в миграции
  should_leave→membership='member' (агент ещё внутри), НЕ →left. Только
  leaved_from_banned/leaved_manual→left.
  Перекликается с [[feedback_check_hidden_schema_consumers_before_renaming]].
- **`channels.channelId` хранится RAW** (`channel.id`, без `-100`), а
  `channels.chatId` — marked (`utils.getPeerId`). `getPostWatchChannels` читает
  `channelId` как raw — нельзя переопределять смысл колонки на месте.
- **`channels.channelId`/`channelAccessHash` = СВЯЗАННЫЙ broadcast-канал**
  (другая сущность), а сам peer, в котором агент состоит, — это
  `chatId`/`chatAccessHash`. Одна строка `channels` описывает два разных peer.
- **Обработки миграции basic_group→супергруппа в коде НЕТ**
  (`migrated_to`/`migratedTo` не встречается) — R6 это новая способность.
- **`session_authorized_at` сейчас не существует** ни в конфиге, ни в БД.
  Все точки записи `sessionString`: `writeSessionString` (reauth-from-tdata,
  главная), `promoteToWorkspace` (autoreg), `promoteToPool` (pool-provision),
  `buildIncoming` (замена — берёт сессию пула, новую не создаёт),
  `authSignIn` (возвращает строку, персистит вызывающий).

**Why:** дизайн опирается на эти факты; при реализации change они — исходные
предпосылки, а не догадки. **How to apply:** перед реализацией перечитать код
этих мест (они могли измениться) и открытые вопросы O-1…O-5 в architecture.md —
их должен закрыть координатор до кодирования.
