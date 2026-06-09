## Why

Несколько Telegram-агентов работают параллельно и ведут трафик в единый приватный канал через пост в своих публичных каналах, но сейчас невозможно увидеть ни активность каждого агента (ответы в группах, личные сообщения), ни рост охвата (просмотры поста, подписчики публичного канала), ни спрос на приватный канал (заявки на вступление). Нужна ежедневная сводка воронки по всем агентам в одном месте.

Полный проработанный дизайн — `docs/funnel-tracking-design.md` (источник истины для этого change).

## What Changes

- Новый oneshot-скрипт сбора метрик воронки (зеркало `src/scripts/daily-summary.ts`), запускаемый systemd-таймером раз в день на границе дня UTC+5.
- Скрипт динамически обнаруживает агентов через `listAgentIds()` и по каждому собирает дневные метрики:
  - **ответы в группах** — COUNT `replies.sentAt` за день UTC+5 (`tg-replies.db`);
  - **личные сообщения** — COUNT `dm_history.sentAt` за день UTC+5 (`tg-channels.db`);
  - **просмотры поста** публичного канала — MTProto-снапшот, дельта за день;
  - **подписчики публичного канала** — MTProto-снапшот `participantsCount`, дельта за день.
- Публичный канал агента определяется **автоматически** из профиля аккаунта (personal channel) через `users.GetFullUser`.
- По **agent1** (админ приватного канала) собирается число **заявок на вступление** в приватный канал — снапшот pending-заявок `GetChatInviteImporters(requested=true)`. ID приватного канала задаётся аргументом `--private-channel <id>`.
- Новая БД `~/.openclaw/workspace-agent1/funnel.db` с таблицами `channel_snapshots` (сырые снапшоты) и `daily_stats` (дневные агрегаты). Защита от двойного прогона — по дню UTC+5 через `channel_snapshots`.
- Ежедневный текстовый отчёт-воронка отправляется в **Saved Messages agent1**.
- **Запуск по требованию:** OpenClaw-инструмент `tg_funnel_report` + скилл `skills/funnel-report/` — агент собирает и показывает воронку в любой момент (срез «на сейчас»), по аналогии с `tg_daily_summary` / `skills/daily-summary`. Срез по требованию считает дельту относительно последнего сохранённого снапшота и **не пишет** постоянный дневной снапшот (чтобы не засорять дневной ряд и не задевать защиту от двойного прогона).
- Новые MTProto-методы в `TelegramService`: получение personal-канала и id поста, просмотры поста, `participantsCount`, заявки на вступление.
- Новые systemd-юниты `tg-funnel-tracker.service` / `.timer`.
- **Вне скоупа (Future Work):** атрибуция вступлений по `user_id`, кумулятивный счёт заявок через `GetAdminLog`, уникальные инвайт-ссылки на агента.

## Capabilities

### New Capabilities
- `funnel-metrics`: обнаружение публичного канала каждого агента и приватного канала agent1, сбор дневных метрик воронки через MTProto и существующие БД агентов, хранение снапшотов и дневных агрегатов в `funnel.db`, инкрементальность и защита от двойного прогона.
- `funnel-report`: формирование и доставка ежедневного текстового отчёта-воронки (активность, охват, заявки) в Saved Messages agent1, а также запуск сбора и показ отчёта по требованию через OpenClaw-инструмент/скилл.

### Modified Capabilities
<!-- Нет: существующие capability и их требования не меняются. Скрипт только читает БД агентов на чтение и не затрагивает поведение скиллов. -->

## Impact

- **Новый код:**
  - `src/scripts/funnel-tracker.ts` — точка входа скрипта (по образцу `daily-summary.ts`).
  - `src/core/db/funnel.ts` — схема и доступ к `channel_snapshots` / `daily_stats`.
  - `src/core/funnel-report.ts` — агрегация дельт и рендер текста отчёта.
  - `src/core/funnel-collect.ts` — общее ядро сбора метрик (используется и таймером, и инструментом по требованию; параметр `persist`).
  - `index.ts` — регистрация инструмента `tg_funnel_report` (ad-hoc сбор через общий `TelegramService` гейтвея, без записи снапшота).
  - `skills/funnel-report/SKILL.md` — скилл запуска отчёта по требованию (зеркало `skills/daily-summary`).
  - Новые методы в `src/core/telegram/service.ts`: `GetFullUser`/personal-канал, `GetMessagesViews`, `GetFullChannel.participantsCount`, `GetChatInviteImporters`.
- **Переиспользуется:** `core/config.listAgentIds`, `core/config` пути к БД агентов (`repliesDbPath`, `channelsDbPath`), `core/runs-summary` хелперы дня UTC+5 (`startOfUtcPlus5Day` / `finishedDayWindow`), `TelegramService.loadAccount` / `sendSavedMessage`.
- **Деплой:** `deploy/systemd/tg-funnel-tracker.service` + `.timer` (OnCalendar 19:00 UTC = 00:00 UTC+5, Persistent), запись в `deploy/README.md`.
- **Внешние зависимости:** только GramJS/MTProto (уже подключён). Новых npm-пакетов нет.
- **Предусловие эксплуатации:** agent1 должен быть админом приватного канала с правом `invite_users` — иначе чтение заявок вернёт `CHAT_ADMIN_REQUIRED` (проверить на живом аккаунте до реализации).
