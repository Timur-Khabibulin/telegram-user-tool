## Why

Право писать в канал сейчас определяется реактивно — из ошибки отправки комментария
(`write_access_reason` заполняется постфактум). Платформа тратит попытку отправки и
антиспам-бюджет живого аккаунта, чтобы лишь затем узнать о запрете, хотя часть
препятствий (выход из группы, бан, ограничение канала самим Telegram, вступительный
ценз, slow-mode) известна из текущего состояния канала и участника до попытки.
Требования и техническое решение — в
[docs/design/channel-write-access/requirements-v1.md](../../../docs/design/channel-write-access/requirements-v1.md)
и [architecture.md](../../../docs/design/channel-write-access/architecture.md).

## What Changes

- **Проактивная проверка статусов перед отправкой.** Перед фазой отправок в
  `monitor-v5` (шаг 5.3c) один живой `GetParticipant` в группе обсуждения даёт статус
  участника и флаги группы (`left`, `restricted`, `slowmode_enabled`, `join_to_send`,
  `join_request`, `default_banned_rights`); access-флаги broadcast берутся из кэша при
  join. По каждому обнаруженному статусу выполняется однозначное действие.
- **Классификация возвращает действие, а не причину.** `write-access.ts`
  переписывается в чистую `classifyWriteAccess(snapshot) → action`
  (`ok`/`autorotate`/`suspend`/`join`/`join_request`).
- **BREAKING: отказ от колонки-гейта.** `channels.write_access_reason` /
  `write_access_until` из использования убираются (колонки остаются мёртвыми до
  отдельной чистки). «Писать нельзя» выражается через существующий `status`
  (`banned`/`suspend`) + журнал. **Режим read-only (читать, но не писать) устраняется**:
  канальные препятствия (`restricted`, `default_banned_rights`, `paid`) уводят канал в
  `suspend`, а не оставляют read-only.
- **Новый тип события `write_access` в журнале операций** с payload
  (`kicked_by`/`date`/`banned_rights`/`restriction_reason`): каждый обнаруженный статус
  фиксируется в ИО.
- **Реактивная ветка становится резервом.** `handlePostCommentSendError` ловит
  препятствия без проактивного сигнала (`paid` → `suspend(∞)`; `CHAT_WRITE_FORBIDDEN`
  → авторотация).
- **`CHANNEL_PRIVATE` при чтении → авторотация** (не `not_found`): потеря доступа
  трактуется как повод передать канал другому аккаунту.

## Capabilities

### New Capabilities
<!-- Нет: переработка ведётся в рамках существующей способности channel-write-access. -->

### Modified Capabilities
- `channel-write-access`: полная замена реактивной модели (`write_access_reason` +
  read-only-гейт) на проактивную «статус → действие» перед отправкой; перечень статусов
  и действий — по requirements-v1.md §3.5.
- `channel-operations-history`: добавляется тип события `write_access` с payload полей
  препятствия.

## Impact

- **Код**: `src/core/write-access.ts` (переписывается), `src/skills/monitor-v5.ts`
  (precheck 5.3c, ветка 5.1), `src/core/post-comment-send.ts` (реактивный резерв),
  `src/core/db/channels.ts` (снятие `setWriteAccessReason`/`clearWriteAccessReason`;
  переиспользование `markChannelStatus`/`expireChannelStatuses`),
  `src/core/db/channel-operations.ts` (тип `write_access` + `recordWriteAccessEvent`),
  `src/core/telegram/service.ts` (`getSelfParticipant` под снимок), `write-access.test.ts`
  (переписывается под действия).
- **Данные**: колонки `channels.write_access_reason`/`write_access_until` перестают
  использоваться (мёртвые, без миграции-дропа); `operations.attrs` несёт новый payload.
  Схема `channels` не мигрируется.
- **Согласование**: с идущими changes `tg-peer-identity-model` (dual-write membership
  через `markChannelStatus` — конфликта нет) и `monitor-v5-hash-driven-sync` (ветка
  `CHANNEL_PRIVATE` 5.1 — единая точка, право записи имеет приоритет → авторотация).
- **Поведенческий сдвиг**: устранение read-only-режима — каналы `paid`/`restricted`/
  «все замьючены» больше не читаются (DM с них не копятся).
