## Why

`monitor-v3` (`channel-post-watch`) сегодня отправляет инициативный комментарий
к посту сразу же, как только LLM даёт `score ≥ POST_COMMENT_SCORE_THRESHOLD`
(`src/skills/monitor-v3.ts`) — без возможности увидеть предложенный текст до
отправки. Во время тюнинга промпта/скоринга (`generatePostCommentV2`) это
не даёт понаблюдать «в моменте», как LLM оценивает посты и что она собирается
написать, прежде чем комментарий реально уйдёт в чат обсуждения канала.
Нужен ручной gate: перед отправкой показывать пост и предложенный комментарий
человеку в Telegram с кнопками Да/Нет — комментарий уходит только при «Да».

## What Changes

- Один общий Telegram-бот (BotFather, один токен) и один общий чат ревьюеров
  (существующая группа с людьми, куда бот добавлен участником). Не по боту на
  агента — принадлежность конкретному агенту определяется данными
  (`pending_reviews.agentId`), а не тем, какой бот прислал сообщение.
- Новая таблица `pending_reviews` (БД агента, рядом с `channels`) — одна
  строка на каждый предложенный комментарий, ожидающий решения человека.
  Без TTL/авто-expiry: не нажали — строка висит бессрочно, разбор ручной.
- `monitor-v3.ts`: вместо немедленной отправки при `score ≥ порога` —
  `INSERT` в `pending_reviews` + `sendMessage` (Bot API) в чат ревьюеров с
  постом, оценкой LLM (`score`/оси) и предложенным комментарием, с
  inline-кнопками `[Да|Нет]` (`callback_data` = id строки). Прогон **не
  блокируется** ожиданием ответа — канал помечается обработанным, dispatcher
  завершается штатно.
- Новый персистентный процесс `review-listener` — один на всю платформу
  (не по одному на агента), постоянно работает, держит единственный
  `getUpdates`-long-poll на токен общего бота. На нажатие кнопки:
  - «Да» — открывает MTProto-сессию нужного агента, отправляет комментарий,
    выполняет ту же пост-отправочную обвязку, что сегодня в `monitor-v3.ts`
    после успешной отправки (тред, `only_comment`, запись ответа) — выносится
    в переиспользуемую функцию, общую для `monitor-v3.ts` и `review-listener`.
  - «Нет» — помечает пост просмотренным тем же путём, что уже используется
    для auto-reject по префильтру/порогу (`markPostSeen`), MTProto не нужен.
  - В обоих случаях редактирует сообщение в чате ревьюеров (убрать кнопки,
    показать исход) и отвечает на callback.
- Новая колонка `channels.chatAccessHash` (аддитивная миграция) — персистентный
  accessHash чата обсуждения, аналог уже существующего `channelAccessHash`.
  Нужна, чтобы `review-listener` на свежем MTProto-соединении мог отправить
  сообщение без похода в `getDialogs` (`peerCache` в `TelegramService` —
  только в памяти процесса, не переживает рестарт).
- Ручной review-gate включается per-agent — новое поле `reviewGateEnabled` в
  `tg-account.json` того же агента; при выключенном gate `monitor-v3`
  отправляет комментарий как сегодня, без изменения поведения.
- Каждое решение человека («Да»/«Нет») логируется безусловно — задел на
  сопоставление с `llm_log` и калибровку `POST_COMMENT_SCORE_THRESHOLD`.

## Capabilities

### New Capabilities
- `post-comment-review`: ручное подтверждение инициативного комментария
  человеком через Telegram-бота с кнопками Да/Нет перед отправкой в чат
  обсуждения канала; асинхронный gate поверх `channel-post-watch`, не
  блокирующий прогон `monitor-v3`.

### Modified Capabilities
- `channel-post-watch` (`openspec/changes/monitor-v3/specs/channel-post-watch`
  — ещё не заархивирован в `openspec/specs/`): шаг отправки комментария
  становится условным — либо прямая отправка (gate выключен), либо постановка
  в очередь на ревью (gate включён), решение принимает `review-listener` по
  результату нажатия кнопки, а не сам `monitor-v3`.

## Impact

- `src/skills/monitor-v3.ts` — точка отправки комментария заменяется на
  ветвление (прямая отправка / постановка в `pending_reviews`); общая
  пост-отправочная обвязка выносится в переиспользуемую функцию.
- `src/core/db/channels.ts` — новая колонка `chatAccessHash`; новая таблица
  `pending_reviews` (новый модуль `src/core/db/pending-reviews.ts` или рядом
  с `channels.ts`).
- `src/core/telegram/service.ts` — точка, где `peerCache` узнаёт accessHash
  чата (`populatePeerCacheForIds`/`getDialogsForBatch`/`listGroupChannels`),
  дополняется персистом в БД.
- Новый скрипт `src/scripts/review-listener.ts` — точка входа персистентного
  процесса (Bot API `getUpdates`, обработка `callback_query`).
- Новый модуль работы с Bot API (`sendMessage`, `editMessageReplyMarkup`,
  `answerCallbackQuery`, `getUpdates`) — в проекте сейчас нет интеграции с
  Telegram Bot API (только MTProto через GramJS).
- Новые переменные в `~/.openclaw/secrets.env` — `TELEGRAM_REVIEW_BOT_TOKEN`,
  `TELEGRAM_REVIEW_CHAT_ID` (платформенный секрет, тем же паттерном, что
  `ASOCKS_API_KEY`, — не per-agent).
- Новый systemd-юнит для `review-listener` (persistent service, не таймер,
  с `EnvironmentFile=-/root/.openclaw/secrets.env`) — `deploy/systemd/`.
- `tg-account.json` — новое поле `reviewGateEnabled` (per-agent флаг).
- Документация: `docs/architecture.md` (новый процесс review-listener),
  `docs/operation.md` (деплой сервиса, секреты бота), `docs/db-schema.puml`
  (`pending_reviews`, `channels.chatAccessHash`).
