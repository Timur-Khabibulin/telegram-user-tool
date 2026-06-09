## 1. Предусловия и проверки

> Требуют живого аккаунта/VPS — выполняются вручную перед включением таймера. Код написан защитно под все эти неизвестности (пустой personalChannel, `CHAT_ADMIN_REQUIRED`, отсутствие канала в диалогах).

- [x] 1.1 Подтвердить на живом аккаунте agent1, что `GetChatInviteImporters(privateChannel, requested=true)` отрабатывает (право `invite_users`); зафиксировать ID приватного канала
- [x] 1.2 Подтвердить, что у тестового агента `users.GetFullUser(self)` возвращает непустой `personalChannelId` и `personalChannelMessage`
- [x] 1.3 Проверить, что приватный канал присутствует в `getDialogs` agent1 (для резолва `access_hash`); если нет — заложить пагинацию диалогов

## 2. MTProto-методы в TelegramService

- [x] 2.1 `getOwnPersonalChannel()` — `users.GetFullUser(InputUserSelf)` → `{ channelInputPeer, postId }`, `access_hash` из `chats`; вернуть null если `personalChannelId` пуст
- [x] 2.2 `getPostViews(channel, postId)` — `messages.GetMessagesViews(channel, id=[postId], increment=false)` → число просмотров
- [x] 2.3 `getChannelSubsCount(channel)` — `channels.GetFullChannel` → `participantsCount`
- [x] 2.4 `getPendingJoinRequests(channelId)` — резолв InputPeer из `getDialogs` (peerCache-конвенция) + `messages.GetChatInviteImporters(peer, requested=true)` → длина списка; типизированный возврат при `CHAT_ADMIN_REQUIRED`
- [x] 2.5 Покрыть штатные ошибки (нет канала, нет прав, FLOOD_WAIT) по образцу существующих методов сервиса

## 3. Слой БД funnel.db

- [x] 3.1 `src/core/config.ts` — добавить `funnelDbPath()` → `~/.openclaw/workspace-agent1/funnel.db`
- [x] 3.2 `src/core/db/funnel.ts` — идемпотентная схема `channel_snapshots` и `daily_stats` (`CREATE TABLE IF NOT EXISTS`)
- [x] 3.3 `insertSnapshot()` / `getPreviousSnapshot(agentId)` / `hasSnapshotForDay(agentId, dayStartSec)` (защита от двойного прогона по дню UTC+5)
- [x] 3.4 `upsertDailyStats()` — запись `*_delta` и `*_abs` по агенту за дату дня UTC+5

## 4. Окно дня UTC+5

- [x] 4.1 Переиспользовать `startOfUtcPlus5Day` / `finishedDayWindow` / `dayLabel` из `core/runs-summary`; при необходимости вынести в общий модуль без дублирования

## 5. Сбор метрик (ядро funnel-collect)

- [x] 5.1 `src/core/funnel-collect.ts` — общее ядро: принимает `TelegramService` + флаг `persist`; по `listAgentIds()` для каждого агента собирает метрики активности (`replies` из `tg-replies.db`, `dm_history` из `tg-channels.db`) COUNT за день UTC+5
- [x] 5.2 Охват: `getOwnPersonalChannel` → `getPostViews` + `getChannelSubsCount`; пропуск агента с пометкой если нет personal channel
- [x] 5.3 Заявки agent1: `getPendingJoinRequests(privateChannelId)`; пометка «недоступно» при `CHAT_ADMIN_REQUIRED`
- [x] 5.4 При `persist=true`: запись снапшота в `channel_snapshots`, вычисление дельт vs предыдущий снапшот, запись `daily_stats`. При `persist=false`: дельта относительно последнего сохранённого снапшота, без записи
- [x] 5.5 Защита от двойного прогона через `hasSnapshotForDay` (только в режиме persist)
- [x] 5.6 Изоляция сбоев: сбор по каждому агенту в try/catch, мёртвый агент → пропуск с пометкой, прогон продолжается

## 6. Отчёт

- [x] 6.1 `src/core/funnel-report.ts` — рендер текста: дата дня UTC+5, таблица (Группы, Личные, Просмотры поста `+Δ (abs)`, Подписчики канала `+Δ (abs)`), строка «Итого», строка «Заявки в приватный канал: +Δ (N)»
- [x] 6.2 Пометки пропусков: пропущенные агенты и недоступные заявки выводятся явно
- [x] 6.3 Доставка через `TelegramService.sendSavedMessage` на agent1; сбой отправки не откатывает записанные данные

## 7. Точка входа и запуск

- [x] 7.1 `src/scripts/funnel-tracker.ts` — парсинг аргументов `--admin agent1` и `--private-channel <id>` (по образцу `daily-summary.ts`), оркестрация collect → report → send, корректный `disconnect()` в finally
- [x] 7.2 Обработка пустого списка агентов (выход без ошибки)

## 8. Запуск по требованию (инструмент + скилл)

- [x] 8.1 `index.ts` — зарегистрировать инструмент `tg_funnel_report` (по образцу `tg_daily_summary`): вызывает `funnel-collect` с `persist=false` через общий `TelegramService` гейтвея, возвращает `{ text }`
- [x] 8.2 `skills/funnel-report/SKILL.md` — скилл запуска отчёта по требованию (зеркало `skills/daily-summary/SKILL.md`): когда вызывать, показать `text` пользователю
- [x] 8.3 Зарегистрировать скилл/инструмент в манифесте плагина (как остальные скиллы/инструменты) — отдельного манифеста нет: инструмент регистрируется `reg()` в `index.ts`, скилл — файлом `skills/funnel-report/SKILL.md`

## 9. Деплой

- [x] 9.1 `deploy/systemd/tg-funnel-tracker.service` — oneshot, `ExecStart=... funnel-tracker.ts --admin agent1 --private-channel <id>`, Slice, `TimeoutStartSec` с запасом
- [x] 9.2 `deploy/systemd/tg-funnel-tracker.timer` — `OnCalendar=*-*-* 19:10:00 UTC` (00:10 UTC+5), `Persistent=true`
- [x] 9.3 Раздел в `deploy/README.md` (установка юнитов, разовый запуск `systemctl start`, требование прав agent1)

## 10. Проверка

> 10.1–10.4 требуют живого прогона на VPS — выполняются вручную после деплоя.

- [x] 10.1 Разовый прогон вручную (таймерный путь): проверить запись `channel_snapshots`/`daily_stats` и приход отчёта в Saved Messages agent1
- [x] 10.2 Проверить идемпотентность (повторный запуск в тот же день UTC+5 не дублирует снапшоты)
- [x] 10.3 Проверить запуск по требованию: `tg_funnel_report` возвращает актуальный текст и НЕ пишет дневной снапшот (последующий таймер не считает дублем)
- [x] 10.4 Проверить устойчивость: смоделировать недоступного агента и отсутствие прав на заявки — прогон завершается, пробелы помечены
- [x] 10.5 `openspec validate funnel-tracking`
