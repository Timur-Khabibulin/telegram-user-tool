## Context

Полный продуктовый и технический дизайн воронки проработан в `docs/funnel-tracking-design.md` — этот документ остаётся источником истины (диаграммы воронки/архитектуры, точные MTProto-вызовы, схема таблиц, формат отчёта, Alternatives, Future Work). Здесь — ключевые инженерные решения и риски для реализации.

Текущее состояние кодовой базы, на которое опирается фича:
- **Кросс-агентный oneshot уже есть** — `src/scripts/daily-summary.ts` сводит таблицы `runs` всех агентов и шлёт текст в Saved Messages админа по systemd-таймеру (`deploy/systemd/tg-daily-summary.{service,timer}`). Funnel-tracker — прямое зеркало этого паттерна.
- **`core/config.listAgentIds()`** обнаруживает агентов по каталогам `~/.openclaw/workspace-<agentId>/`; там же — пути к per-agent БД (`repliesDbPath` → `tg-replies.db`, `channelsDbPath` → `tg-channels.db`).
- **`core/runs-summary.ts`** уже считает границу дня UTC+5 (`startOfUtcPlus5Day`, `finishedDayWindow`, `dayLabel`).
- **`TelegramService`** (`core/telegram/service.ts`) — ленивый клиент по аккаунту, конвенция **peerCache** (InputPeer берётся из `getDialogs`, не через `getEntity(BigInt)` — иначе `PEER_ID_INVALID` после перезапуска процесса). `GetFullChannel` уже вызывается (в join-discussion).
- **`loadAccount` + `sendSavedMessage`** — загрузка `tg-account.json` и отправка в чат «me».

Отличие от daily-summary: funnel-tracker подключается к **каждому** агенту (через его прокси), а не только к admin.

## Goals / Non-Goals

**Goals:**
- Раз в день собрать по каждому агенту дневные метрики воронки и сохранить снапшоты + агрегаты в `funnel.db`.
- Авто-обнаружение публичного канала агента (personal channel из профиля) — без конфига на агента.
- Снять с agent1 число заявок на вступление в приватный канал.
- Идемпотентность: повторный запуск за тот же день UTC+5 не дублирует данные.
- Отправить читаемый текстовый отчёт в Saved Messages agent1.

**Non-Goals:**
- Атрибуция вступлений/заявок по `user_id` (Future Work).
- Кумулятивный счёт заявок через `GetAdminLog` (Future Work; первая итерация — снапшот pending).
- Real-time, дашборды, хранение истории переписки.

## Decisions

**1. Standalone oneshot-скрипт + systemd-таймер (а не OpenClaw-скилл/диспетчер).**
Метрика кросс-агентная, как daily-summary. Диспетчер (`scripts/dispatcher.ts`) — per-agent и для другой задачи. Зеркалим daily-summary: `src/scripts/funnel-tracker.ts`, `tg-funnel-tracker.{service,timer}`, OnCalendar 19:00 UTC = 00:00 UTC+5, Persistent. Альтернатива (cron на каждого агента, каждый пишет свои метрики) отклонена — размазывает логику агрегации.

**2. Публичный канал — из personal channel профиля (`users.GetFullUser(self)`).**
`personalChannelId` + `personalChannelMessage` дают канал и id единственного поста; `access_hash` берётся из `chats` того же ответа (peerCache-конвенция). Это убирает любой per-agent конфиг каналов. Альтернатива (хранить `publicChannelId` в каждом `tg-account.json`) отклонена как лишняя ручная настройка.

**3. Приватный канал — ID аргументом `--private-channel <id>`, access_hash из `getDialogs` agent1.**
agent1 — админ (не создатель), приватный канал в профиль не закреплён, из `GetFullUser` его не получить. Один аргумент запуска (как `--admin agent1` у daily-summary). access_hash резолвится из диалогов agent1 (он участник). Альтернатива (распарсить инвайт-ссылку из поста и `CheckChatInvite`) — config-free, но хрупкая на парсинге; отложена.

**4. Метрика приватного канала — заявки (pending snapshot), не участники.**
`messages.GetChatInviteImporters(peer, requested=true)` → длина списка неодобренных заявок. Семантически это «спрос» — верх воронки. Снапшотим раз в день, дельта = новые заявки (корректно, пока заявки не одобряют массово). Альтернатива (кумулятив через `GetAdminLog`) устойчивее, но требует пагинации лога — в Future Work.

**5. Два слоя хранения: `channel_snapshots` (сырьё) + `daily_stats` (агрегаты).**
Сырые снапшоты позволяют пересчитать дельты при пропуске/ошибке прогона. Дельта = текущий снапшот − предыдущий снапшот того же `agent_id`. Альтернатива (только агрегаты) отклонена — теряется восстановимость.

**6. Граница дня и идемпотентность — UTC+5, переиспользуем `runs-summary`.**
Окна «Воронки» и «Дневной сводки» обязаны совпадать. Защита от двойного прогона — проверка наличия снапшота с `snapped_at` в текущем дне UTC+5 в `channel_snapshots` (отдельная таблица состояния не нужна).

**7. Устойчивость к сбою отдельного агента.**
Сбор по каждому агенту в try/catch: мёртвая сессия/прокси/отсутствие personal-канала → агент пропускается с пометкой в отчёте, прогон остальных продолжается (как daily-summary пропускает битую БД).

**8. Два режима запуска: таймер (persist) и по требованию (ad-hoc) на общем ядре сбора.**
Зеркало daily-summary (таймер = завершившийся день, пишущий данные; скилл `tg_daily_summary` = текущий день «так далеко»). Ядро `funnel-collect` принимает `TelegramService` и флаг `persist`:
- **Таймер** (`finishedDayWindow`, `persist=true`): авторитетный дневной срез — пишет `channel_snapshots` + `daily_stats`, под защитой от двойного прогона.
- **По требованию** (инструмент `tg_funnel_report` в `index.ts` + скилл `skills/funnel-report`, `persist=false`): собирает текущие MTProto-значения, считает дельту относительно **последнего сохранённого** снапшота («с последнего среза»), рендерит и возвращает текст, **не пишет** постоянный снапшот и не задевает защиту от двойного прогона. Использует общий `TelegramService` гейтвея (loadAccount/connect по каждому агенту).

Альтернатива (по требованию просто перечитывать последний `daily_stats` без свежего сбора) отклонена — пользователю нужны актуальные числа «на сейчас», а дневные снапшоты берутся раз в день.

## Risks / Trade-offs

- **Прав agent1 недостаточно (`CHAT_ADMIN_REQUIRED`)** → метрика заявок недоступна. Mitigation: проверить право `invite_users` на живом аккаунте до реализации (один вызов); при ошибке — пропустить блок заявок с явной пометкой в отчёте, не валить весь прогон.
- **Одобрение заявок искажает дневную дельту** (pending уменьшается, дельта может стать отрицательной). Mitigation: в отчёте показываем и абсолют, и дельту; в доке зафиксирован апгрейд на `GetAdminLog` (Future Work).
- **Подключение к N аккаунтам последовательно через прокси** — время прогона и риск FLOOD_WAIT. Mitigation: только read-операции (GetFullUser/GetFullChannel/GetMessagesViews/GetChatInviteImporters), один проход в день; per-agent изоляция ошибок; `TimeoutStartSec` в юните с запасом.
- **`personalChannelId` пуст** (агент не закрепил канал в профиле) → нет публичных метрик по агенту. Mitigation: пропуск агента с пометкой, прогон не падает.
- **`access_hash` приватного канала отсутствует в топ-диалогах agent1** (известное ограничение окна `getDialogs` на 100). Mitigation: при необходимости — пагинация диалогов или fallback на `CheckChatInvite` из ссылки (Future Work). На старте приватный канал — активный диалог agent1, попадает в топ.
- **Запуск по требованию синхронно подключается ко всем агентам** в рамках одного вызова инструмента (латентность, риск FLOOD_WAIT при частых вызовах). Mitigation: только read-операции; инструмент инициируется пользователем (редко); приемлемая задержка ответа; при необходимости позже вынести в фоновый запуск. На общую логику не влияет — то же ядро `funnel-collect`, что и у таймера.

## Migration Plan

- Чистое добавление: новые файлы (`scripts/funnel-tracker.ts`, `core/db/funnel.ts`, `core/funnel-report.ts`), новые методы в `TelegramService`, новые systemd-юниты. Существующее поведение скиллов/диспетчера не меняется — funnel-tracker только читает per-agent БД на чтение.
- `funnel.db` создаётся идемпотентно при первом прогоне (`CREATE TABLE IF NOT EXISTS`), миграций данных нет.
- Развёртывание: скопировать юниты в `/etc/systemd/system/`, `daemon-reload`, `enable --now tg-funnel-tracker.timer`. Разовый прогон — `systemctl start tg-funnel-tracker.service`.
- Откат: `systemctl disable --now tg-funnel-tracker.timer`; `funnel.db` можно удалить — на остальную систему не влияет.

## Open Questions

- Точное право/поведение `GetChatInviteImporters` для agent1 на проде (подтвердить `invite_users`).
- Гарантированно ли приватный канал попадает в топ-100 диалогов agent1, или сразу закладывать пагинацию.
