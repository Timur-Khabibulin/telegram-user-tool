## 1. Схема БД и типы канала

- [x] 1.1 Расширить `ChannelStatus` в `src/core/db/channels.ts` значениями
      `"only_comment"` и `"sleep"`.
- [x] 1.2 Добавить аддитивную миграцию колонок `lastSeenChannelPostId`
      (INTEGER, nullable) и `watchedThreadRootMsgId` (INTEGER, nullable) в
      `channels` — по образцу `migrateStatusColumns`, с проверкой через
      `PRAGMA table_info`.
- [x] 1.3 Добавить функцию выборки активных каналов с публичным username
      (`status` — `NULL`/`format_error`/`only_comment`, `channelUsername IS
      NOT NULL`) — фильтр на уровне SQL, по образцу `getChannelsBatch`.
- [x] 1.4 Обновить `docs/db-schema.puml` — новые поля и значения статуса
      канала.

## 2. Веб-превью канала (обнаружение поста)

- [x] 2.1 Добавить зависимость `cheerio` в `package.json`.
- [x] 2.2 Создать модуль `src/core/channel-preview/` — запрос
      `t.me/s/<username>` и разбор последнего поста (id, дата публикации,
      текст) по селекторам `.tgme_widget_message_wrap`,
      `.tgme_widget_message_date`, `.tgme_widget_message_bubble`.
- [x] 2.3 Обработать случаи отсутствия постов / ошибки запроса (канал
      недоступен, сеть) — без падения вызывающего кода.

## 3. MTProto: доступ к ветке обсуждения по id поста

- [x] 3.1 Добавить метод `TelegramService` поверх
      `messages.getDiscussionMessage` — резолв корневого сообщения ветки
      обсуждения по каналу и id поста, без вступления в сам канал.
- [x] 3.2 Использовать этот метод и для локализации служебной копии
      свежего поста (первый комментарий), и для дешёвой проверки
      `unread_count` уже отслеживаемой ветки.

## 4. LLM: инициативный комментарий к посту

- [x] 4.1 Добавить в `src/llm/prompts.ts` промпт генерации инициативного
      комментария по тексту поста (персона агента, решение писать/не
      писать + текст комментария) — не переиспользует
      `generateReply`/`generateThreadReply`.
- [x] 4.2 Добавить дешёвый эвристический отсев текста поста до LLM-вызова
      (по аналогии с `passesPrefilter` в `monitor-v2.ts`).

## 5. Скилл monitor-v3

- [x] 5.1 Создать `src/skills/monitor-v3.ts` — точка входа `runMonitorV3`
      по сигнатуре `SkillContext => SkillStatus`, по алгоритму из
      `docs/design/monitor-v3/design-v1.md` (§0-§2) /
      `algorithm-flow.puml`.
- [x] 5.2 §0 Подготовка: загрузка сессии, синхронизация каналов, резолв
      идентичности, снятие просроченных `banned`/`suspend`/`format_error`/
      `sleep`, выборка активных каналов с публичным username (задача 1.3).
- [x] 5.3 §1 Проверка удалённых сообщений — скопировать и адаптировать
      логику `channel-suspend-on-deletion` из `monitor-v2.ts` (включая
      `getAgentSentMessageIds`, порог, установку `suspend`).
- [x] 5.4 §2a Обработка `status = only_comment`: переход в `sleep` по
      истечении 2 суток; иначе — проверка и обработка новых сообщений в
      отслеживаемой ветке (классификация, генерация ответа,
      `updateGroupThread`).
- [x] 5.5 §2b Ветка «Открыт»: запрос веб-превью (задача 2.2), guard по
      `lastSeenChannelPostId`, проверка возраста (R1, 24ч), отсев + LLM-
      решение (задача 4), поиск служебной копии поста (задача 3.1/3.2),
      отправка.
- [x] 5.6 §2b.vi Исход отправки — скопировать и адаптировать классификацию
      ошибок (`FLOOD_WAIT`/`PEER_FLOOD`/бан на запись/запрет формата/
      прочая ошибка) из `monitor-v2.ts`, включая обновление `status`
      канала и приостановку агента при необходимости.
- [x] 5.7 §2b.vii При успехе — создание треда (`createGroupThread`),
      пометка прочитанным, `recordChannelVisit`, запись
      `lastSeenChannelPostId`/`watchedThreadRootMsgId`, установка
      `status = only_comment`.

## 6. Расписание и регистрация

- [x] 6.1 Добавить `"monitor-v3"` в `TaskType` (`src/core/db/tasks.ts`) и
      запись в `DEFAULT_PERIODIC_SCHEDULE` (`periodMinutes: 300`).
- [x] 6.2 Зарегистрировать `runMonitorV3` в `SKILLS` (`src/scripts/dispatcher.ts`).
- [x] 6.3 Обновить `docs/task-scheduling.md` — дефолтное расписание
      `monitor-v3`.
- [x] 6.4 Обновить `docs/operation.md` — влияние нового каданса на ёмкость/
      нагрузку (если применимо).
