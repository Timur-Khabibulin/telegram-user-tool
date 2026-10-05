## 1. Шаблон персоны: поле и ридер

- [x] 1.1 Добавить опциональное поле `funnelPrivateChannelId?: string` в интерфейс `ProfileData` (`src/features/tg-agent-autoregistration/persona-template.ts`) и прокинуть его в `loadPersonaTemplate` без требования наличия (не ломать существующую валидацию profile_data.json)
- [x] 1.2 Добавить лёгкий ридер `readPersonaFunnelChannelId(persona: string): string | null` — читает только `profile_data.json` персоны, возвращает `null` при отсутствии файла/поля, не требует канальных файлов
- [x] 1.3 Добавить построитель карты `persona → funnelPrivateChannelId` (одно чтение на персону), например в `core/config.ts` или рядом с `buildPersonaIndex` — и резолвер `agentId → funnelPrivateChannelId | null` поверх `buildPersonaIndex`

## 2. Создание инвайт-ссылок

- [x] 2.1 `apply-persona.ts:55` — резолвить канал из шаблона персоны (`persona` уже в параметрах); при отсутствии канала — не создавать ссылку, вернуть/залогировать пропуск
- [x] 2.2 `private-invite-links/run.ts:123` — резолвить канал по персоне каждого агента (`agentId → persona → funnelPrivateChannelId`); агент без канала персоны помечается пропущенным (`createErrors`/отдельная пометка), обработка остальных продолжается
- [x] 2.3 Убрать импорт `FUNNEL_PRIVATE_CHANNEL_ID` из обоих файлов

## 3. Сбор воронки (collectFunnel)

- [x] 3.1 Убрать `privateChannelId` из `CollectOptions`; строить внутри карту `persona → channelId` (или принимать готовую)
- [x] 3.2 В основном цикле: резолвить канал агента по персоне; если канала нет — `privateRequestsAbs = null`, MTProto-запрос не выполнять; иначе `getPendingJoinRequests(channelPersona, {link})`
- [x] 3.3 Тот же резолвинг для блока `inactiveLinkedAgents` (агенты со ссылкой вне фильтра активности)
- [x] 3.4 Заменить единый `privateRequestsAbs`/`privateRequestsDelta` в `FunnelResult` на разрез по персонам (`privateRequestsByPersona: Map<persona, {abs, delta, note?}>`); поля per-agent в `AgentFunnelRow` сохранить
- [x] 3.5 Обработать `CHAT_ADMIN_REQUIRED` per-channel: пометка недоступности для агентов затронутой персоны, не для всех

## 4. Отчёт воронки

- [x] 4.1 `funnel-report.ts` — вывести итог заявок отдельным значением на персону (сумма по её агентам) вместо единой платформенной суммы; ячейка агента без изменений
- [x] 4.2 Прочерк в ячейке заявок агента, если нет ссылки ИЛИ у персоны нет канала; пометка под таблицей «канал персоны не задан», где уместно
- [x] 4.3 CSV (`buildFunnelCsv`) — согласовать с итогом по персонам

## 5. Точки входа и удаление константы

- [x] 5.1 `index.ts:1170` (`tg_funnel_report`) — не передавать `privateChannelId`; полагаться на резолвинг внутри `collectFunnel`
- [x] 5.2 `funnel-tracker.ts:41` — удалить аргумент `--private-channel` и его использование
- [x] 5.3 Удалить константу `FUNNEL_PRIVATE_CHANNEL_ID` из `src/core/config.ts`; убедиться, что не осталось импортёров (grep)

## 6. Документация и инфраструктура

- [x] 6.1 `docs/configuration.md` — убрать строку про `FUNNEL_PRIVATE_CHANNEL_ID`, описать поле `funnelPrivateChannelId` в шаблоне персоны
- [x] 6.2 `deploy/systemd/tg-funnel-tracker.service` — обновить комментарий (id больше не захардкожен)
- [x] 6.3 Обновить ссылки на константу в docs/design и openspec (где это нормативно значимо)

## 7. Проверка и миграция данных

- [x] 7.1 Прогнать typecheck; grep по `FUNNEL_PRIVATE_CHANNEL_ID` и `--private-channel` — не осталось использований
- [x] 7.2 Локально/на сервере: вписать `funnelPrivateChannelId = -1003698044714` в `profile_data.json` персоны maria (миграция существующего канала)
- [x] 7.3 Для персон без канала убедиться, что сбор не падает и заявки помечаются пропущенными
- [x] 7.4 После деплоя: прогон `funnel-tracker` показывает заявки по персонам, у maria — прежнее значение
