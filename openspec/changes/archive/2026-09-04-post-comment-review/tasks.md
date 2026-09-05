## 1. Схема БД

- [x] 1.1 Добавить колонку `channels.chatAccessHash` (TEXT, nullable) —
      аддитивная миграция через `ALTER TABLE ... ADD COLUMN` с проверкой
      `PRAGMA table_info`, тем же паттерном, что и существующие колонки
      (`channels.ts`)
- [x] 1.2 Заполнять `chatAccessHash` в тех точках `TelegramService`, где
      `peerCache` уже узнаёт accessHash чата — добавлены
      `getCachedChatAccessHash`/`seedPeerCache` в `service.ts`, вызов из
      `monitor-v3.ts` §0.6b после `populatePeerCacheForIds`
- [x] 1.3 Создать таблицу `pending_reviews` (agentId неявен — своя БД
      агента; id, chatId, postText, llmScore/llmAxes, comment, rootMsgId,
      createdAt, status) и функции доступа (`insertPendingReview`/
      `getPendingReview`/`resolvePendingReview` — `src/core/db/pending-reviews.ts`)
- [x] 1.4 Отдельного лога решений не заводили — статус пишется безусловно в
      ту же строку `pending_reviews` (уже содержит llmScore/llmAxes рядом),
      этого достаточно для сопоставления с `llm_log` (design.md, решение 10)

## 2. Пост-отправочная обвязка (общая для прямой отправки и одобрения)

- [x] 2.1 Вынесено в `src/core/post-comment-send.ts`:
      `applyApprovedComment(agentId, chatId, params, log, source)` (успешная
      отправка) и `handlePostCommentSendError(agentId, chatId, err, log,
      source)` (классификация ошибок — тоже общая, design.md решение 12)
- [x] 2.2 `monitor-v3.ts` переключён на оба — инлайн-блоки удалены,
      поведение не изменено (то же копирование побочных эффектов, что было)

## 3. monitor-v3: постановка на ревью

- [x] 3.1 `isReviewGateEnabled(agentId)` — `config.ts`, читает
      `reviewGateEnabled` из `tg-account.json`
- [x] 3.2 После `getDiscussionMessage`, до `sendReply` — при включённом
      review-gate: `insertPendingReview` + `sendReviewMessage` (пост, score/
      оси, комментарий, agentId/канал, кнопки Да/Нет); при выключенном —
      прежний путь прямой отправки (2.2)
- [x] 3.3 Постановка на ревью не блокирует прогон — `markChannelProcessed` +
      `continue` сразу после, без ожидания

## 4. Bot API — минимальный клиент

- [x] 4.1 `src/core/review-bot-api.ts`: `sendReviewMessage` (с inline-
      клавиатурой Да/Нет), `editReviewMessageOutcome`, `answerCallbackQuery`,
      `getReviewCallbackUpdates` (long-poll с offset)
- [x] 4.2 `sendReviewMessage`/`editReviewMessageOutcome` НЕ принимают `chatId`
      параметром — захардкожен `TELEGRAM_REVIEW_CHAT_ID`; единственный
      модуль в проекте, вызывающий Bot API (design.md, решение 11)
- [x] 4.3 Логирование — только метод и статус ответа, НЕ URL/тело запроса
- [x] 4.4 `TELEGRAM_REVIEW_BOT_TOKEN`/`TELEGRAM_REVIEW_CHAT_ID` — константы в
      `config.ts` из `process.env` (заполняются из `~/.openclaw/secrets.env`
      на VPS, паттерн `ASOCKS_API_KEY`, не per-agent)

## 5. review-listener

- [x] 5.1 `src/scripts/review-listener.ts` — персистентный процесс,
      единственный потребитель `getReviewCallbackUpdates` (long-poll)
- [x] 5.2 Default-deny уже на уровне `review-bot-api.ts`
      (`getReviewCallbackUpdates` фильтрует по чату/типу апдейта/формату
      `callback_data` до того, как список коллбеков доходит до
      review-listener); `handleCallback` дополнительно идемпотентен —
      `review.status !== "pending"` → игнор (защита от повторной доставки
      апдейта после рестарта процесса, design.md решение 11)
- [x] 5.3 Ветка «Да» (`handleApprove`): `loadAccount` + `seedPeerCache` из
      `chatAccessHash` (без `getDialogs`) + `replyToMessage` (с
      `withFloodRetry`); при ошибке — `handlePostCommentSendError` (та же
      классификация, что в `monitor-v3.ts`, design.md решение 12), статус
      остаётся pending (кнопки живы — можно повторить); при успехе —
      `applyApprovedComment` + `resolvePendingReview("approved")`, затем
      disconnect
- [x] 5.4 Ветка «Нет» (`handleReject`): `markPostSeen` +
      `resolvePendingReview("rejected")` — без MTProto-соединения
- [x] 5.5 В обоих случаях: `editReviewMessageOutcome` (текст с исходом,
      кнопки исчезают вместе с текстом сообщения) + `answerCallbackQuery`;
      решение зафиксировано в самой строке `pending_reviews` (1.4)

## 6. Деплой

- [x] 6.1 Бот создан, добавлен только в чат ревьюеров (сделано оператором
      вручную в ходе обсуждения; конвертация в супергруппу не требуется —
      см. design.md, принятый риск в Risks/Trade-offs)
- [x] 6.2 `deploy/systemd/tg-review-listener.service` — `Type=simple`,
      `Restart=always`, `EnvironmentFile=-/root/.openclaw/secrets.env`
- [x] 6.3 `docs/configuration.md` (секреты + `reviewGateEnabled` в
      tg-account.json), `docs/operation.md` (юнит в таблице + команда
      `systemctl enable --now`)

## 7. Документация

- [x] 7.1 `docs/architecture.md` — `review-listener`, `post-comment-send.ts`,
      `review-bot-api.ts`, таблица `pending_reviews` в слое данных
- [x] 7.2 `docs/db-schema.puml` — пакет `pending-reviews.db`,
      `channels.chatAccessHash`
