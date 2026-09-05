## 1. Данные — забаненные каналы за сутки

- [x] 1.1 `src/core/db/channels.ts`: добавить `countChannelsBannedInWindow(agentId, startSec, endSec): number` (по образцу `countVisitsToday` — `SELECT COUNT(*) FROM channels WHERE status='banned' AND statusUpdatedAt >= startSec AND statusUpdatedAt < endSec`, `fs.existsSync` guard, try/catch → 0).

## 2. Данные — ограничения агентов за сутки

- [x] 2.1 `src/core/db/agent-restrictions.ts`: добавить `listRestrictionsSince(adminAgentId, startSec, endSec): AgentRestrictionRow[]` (`SELECT ... FROM agent_restrictions WHERE restricted_at >= startSec AND restricted_at < endSec`).

## 3. Сбор метрик (funnel-collect.ts)

- [x] 3.1 Добавить поле `channelsBannedToday: number` в `AgentFunnelRow`.
- [x] 3.2 В блоке этапов 1-4 `collectFunnel` (тот же try/catch, что `channelsVisited`/`channelsActive`) вызывать `countChannelsBannedInWindow(agentId, window.startSec, window.endSec)` и записывать в `row.channelsBannedToday`.
- [x] 3.3 Добавить поле `restrictedAgents: { agentId: string; restrictionType: RestrictionType }[]` в `FunnelResult`.
- [x] 3.4 Вне цикла по агентам (рядом с блоком заявок в приватный канал) вызвать `listRestrictionsSince(adminAgentId, window.startSec, window.endSec)` и заполнить `result.restrictedAgents` — без фильтрации по `activeAgentIds`.

## 4. Рендер отчёта (funnel-report.ts)

- [x] 4.1 `buildFunnelCsv`: добавить столбец `каналов_забанено_сегодня` в главную таблицу (`header` + `rows` + `total` — сумма по агентам).
- [x] 4.2 `buildFunnelCsv`: добавить третью таблицу после разбивки по каналам (пустая строка-разделитель, как между main и breakdown) — заголовок `agent_id, restriction_type`, строки из `r.restrictedAgents`.
- [x] 4.3 `renderFunnel`: добавить строку с числом `r.restrictedAgents.length` (рядом с блоком «Ошибки за день»/«Проблемные каналы»).

## 5. Проверка

- [x] 5.1 `npx tsc --noEmit --module esnext` — новых ошибок компиляции относительно текущего baseline нет (только pre-existing better-sqlite3/bigint/index.ts ошибки).
- [x] 5.2 Смоук-тест на временных SQLite-БД (`~/.openclaw/workspace-smoketestagent`, `workspace-smoketestadmin`, удалены после прогона): `countChannelsBannedInWindow` вернул 2 из 3 (третий канал вне окна), `listRestrictionsSince` вернул только ограничение внутри окна (второе, вне окна, отфильтровано), `buildFunnelCsv`/`renderFunnel` на собранном `FunnelResult` содержат новый столбец, третью таблицу и строку счётчика с ожидаемыми значениями.
- [x] 5.3 Сверено со сценариями `specs/funnel-report/spec.md`: банов>0 и наложенное-в-окне ограничение — покрыты смоук-тестом; банов=0 — дефолт `channelsBannedToday: 0` в инициализации `row`; ограничение вне окна отфильтровано смоук-тестом; пустая таблица ограничений (только заголовок) — `buildFunnelCsv` всегда строит `restrictionsHeader` независимо от длины `restrictedAgents`.
