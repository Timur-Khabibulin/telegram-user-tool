## 1. Схема данных

- [x] 1.1 Добавить в `core/db/channels.ts` аддитивную миграцию `channels`:
      `lastCheckedTargetDate TEXT NULL`, `lastCheckedTargetPostId INTEGER NULL`
      (проверка через `PRAGMA table_info`, тот же паттерн, что у
      `lastSeenChannelPostId`/`watchedThreadRootMsgId`).
- [x] 1.2 Добавить функции чтения/записи кэша дня в `core/db/channels.ts`:
      получить `(lastCheckedTargetDate, lastCheckedTargetPostId)` канала;
      сохранить новую пару (включая `null` как валидный id — «день пуст»).

## 2. Поиск поста в диапазоне дат (веб-превью)

- [x] 2.1 В `core/channel-preview/preview.ts` добавить
      `fetchLastPostInDateRange(username, startSec, endSec, log)` — обход
      `.tgme_widget_message_wrap` от новых постов к старым, пагинация
      `?before=<id самого старого поста страницы>` без ограничения глубины
      (design.md, Decision 2).
- [x] 2.2 Разграничить исходы: `{ ok: true, post }` (кандидат найден),
      `{ ok: true, post: null }` (окно дня пусто — дошли до даты
      `< startSec`, не встретив попадания), `{ ok: false }` (сеть/HTTP/парсинг
      не удались на любой странице пагинации) — не путать «пусто» с
      «не удалось» (design.md, Risks).
- [x] 2.3 Логировать число загруженных страниц на канал за поиск (для
      последующего наблюдения за очень активными каналами).

## 3. Вычисление целевого дня

- [x] 3.1 Добавить в `core/config.ts` (или отдельный модуль-утилиту) функцию
      вычисления границ целевого дня `[startOfDay(сегодня−2), startOfDay(сегодня−1))`
      в unix-секундах по календарю `Asia/Yekaterinburg`, и строки даты
      `"YYYY-MM-DD"` для сравнения с кэшем.

## 4. Скилл monitor-v4

- [x] 4.1 Создать `src/skills/monitor-v4.ts` (`runMonitorV4`) — копия
      `monitor-v3.ts`: §0 (загрузка аккаунта, синхронизация каналов, кэш
      идентичности, снятие просроченных статусов, выборка активных каналов,
      заполнение peerCache), §1 (проверка удалённых сообщений), §2a
      (`only_comment`), обработка ошибок отправки (`FLOOD_WAIT`/`PEER_FLOOD`/
      бан на запись/запрет формата) — без изменений по существу.
- [x] 4.2 Переписать §2b («Открыт»): вычислить целевой день (3.1) → если
      `lastCheckedTargetDate` канала совпадает — использовать закэшированный
      `lastCheckedTargetPostId` без обращения к веб-превью; иначе —
      `fetchLastPostInDateRange` (2.1) и сохранить результат в кэш (1.2)
      только при `ok: true`.
- [x] 4.3 Дальше по §2b — как в `monitor-v3`: сравнить найденный id с
      `lastSeenChannelPostId` (skip при совпадении) → эвристический отсев
      текста → LLM-решение (`generatePostCommentV3`) → поиск служебной копии
      в чате обсуждения → отправка → `applyApprovedComment` (переход в
      `only_comment`, сохранение `lastSeenChannelPostId`/`watchedThreadRootMsgId`).
- [x] 4.4 Итоговый статус-отчёт скилла (аналог `details` у `monitor-v3`) —
      добавить счётчик резолвов дня из кэша vs. через сеть, для наблюдения
      за экономией запросов.

## 5. Регистрация задачи

- [x] 5.1 `core/db/tasks.ts`: `TaskType` += `"monitor-v4"`.
- [x] 5.2 `scripts/dispatcher.ts`: `SKILLS["monitor-v4"] = runMonitorV4`.
- [x] 5.3 `core/db/channels.ts`: `SendErrorSource` += `"monitor_v4"` (по
      аналогии с `"monitor_v3"`, для отделения ошибок в отчётах воронки).

## 6. Документация

- [x] 6.1 `skills/scheduler-control/SKILL.md` — добавить `monitor-v4` в
      таблицу типов задач.
- [x] 6.2 `docs/task-scheduling.md` — добавить строку каданса `monitor-v4`
      (5ч, `Asia/Yekaterinburg`, по аналогии с `monitor-v3`).
- [x] 6.3 `docs/architecture.md` — упомянуть `monitor-v4` рядом с `monitor-v3`
      как параллельный, независимо включаемый вариант.

## 7. Проверка

- [x] 7.1 `npx tsc --noEmit` — типы проходят без ошибок (новые/изменённые
      файлы; окружение репозитория имеет предсуществующие несвязанные ошибки
      конфигурации — см. итоговое сообщение).
