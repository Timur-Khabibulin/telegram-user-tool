## 1. Фильтр активных агентов (US-4) — фундамент для остальных шагов

- [x] 1.1 `src/core/db/tasks.ts`: добавить `isAgentActive(agentId): boolean` — переиспользует `listTasks(agentId)`, `true` если есть строка с `type IN ('monitor', 'monitor-v2')` и `enabled = 1`
- [x] 1.2 `src/core/funnel-collect.ts`: в начале `collectFunnel` вычислить `const activeAgentIds = listAgentIds().filter(isAgentActive)` один раз
- [x] 1.3 Заменить `for (const agentId of listAgentIds())` основного цикла на `for (const agentId of activeAgentIds)`
- [x] 1.4 Убедиться, что неактивный агент не создаёт `AgentFunnelRow` и не встречается ни в тексте, ни в CSV, ни в какой-либо пометке

## 2. US-1 — убрать медиану интенсивности

- [x] 2.1 `src/core/db/channels.ts`: удалить `medianActivityRate()` (проверить отсутствие других вызывающих перед удалением)
- [x] 2.2 `src/core/funnel-collect.ts`: убрать вызов `medianActivityRate` и поле `activityRateMedian` из `AgentFunnelRow`
- [x] 2.3 `src/core/funnel-report.ts`: удалить `fmtActive()`, ячейка «Актив» печатает `String(a.channelsActive)` напрямую
- [x] 2.4 `src/core/funnel-report.ts` (`buildFunnelCsv`): удалить столбец `медиана_активности_сообщ_в_час`

## 3. US-2 — «каналы с отправкой» вместо счёта сообщений; DM исключены

- [x] 3.1 `src/core/db/replies.ts`: добавить `getChannelSendBreakdown(agentId, startSec, endSec): ChannelSendAgg[]` (`chatId`, `msgCount`, `lastReplyMsgId` — `GROUP BY chatId`, `MAX(replyMsgId)`), удалить `getDistinctRepliedChatIds` (единственный вызывающий переезжает на новую функцию)
- [x] 3.2 `src/core/funnel-collect.ts`: заменить вызов `getDistinctRepliedChatIds` на `getChannelSendBreakdown`; `potentialReach` считать через `sumAvgViewsForRepliedChannels(agentId, breakdown.map(b => b.chatId))` (список тот же, из нового запроса)
- [x] 3.3 `AgentFunnelRow`: добавить `channelsWithSending: number` (= `breakdown.length`, только для отображения, не персистится) и `channelBreakdown: ChannelSendBreakdownRow[]` (см. группу 5)
- [x] 3.4 `funnel-collect.ts`: убрать вызов `countSince(channelsDbPath(agentId), "dm_history", …)` — DM больше не читаются для воронки; удалить `dmsSent` как поле сбора
- [x] 3.5 `upsertDailyStats`: передавать `dmsSent: 0` жёстко (колонка `daily_stats.dms_sent` остаётся в схеме, без миграции, комментарий в коде — почему всегда 0)
- [x] 3.6 `upsertDailyStats`: `groupReplies: row.groupReplies` — оставить без изменений (внутренний подсчёт для `funnel-stats`, не выводится в отчёте)
- [x] 3.7 `src/core/funnel-report.ts`: столбец «Отпр» (текст) и `сообщений_отправлено`→`каналов_с_отправкой` (CSV) показывают `a.channelsWithSending`; обновить легенду под таблицей

## 4. US-3 — заявки в приватный канал по агенту

- [x] 4.2 `src/core/telegram/service.ts`: `getPendingJoinRequests(channelId, opts?: { link?: string })` — передать `link: opts?.link` в `Api.messages.GetChatInviteImporters`; без `opts.link` поведение не меняется
- [x] 4.3 `src/core/funnel-collect.ts`: шаг сбора заявок — заменить единственный вызов через `REPORT_AGENT_ID` без `link` на цикл по `listPrivateInviteLinks(adminAgentId)`, отфильтрованным до `activeAgentIds`; один `tg.loadAccount(REPORT_AGENT_ID)` на весь цикл; результат — `Map<agentId, count>`; ошибка одного агента не прерывает цикл по остальным
- [x] 4.4 Внутри основного цикла по агентам: `row.privateRequestsAbs = privateAbsByAgent.get(agentId) ?? null` (не 0); дельта — через `getPreviousSnapshot(adminAgentId, agentId)`, как у `postViewsAbs`
- [x] 4.5 `insertSnapshot`/`upsertDailyStats`: снять условие `agentId === adminAgentId` — писать `privatePendingRequests`/`privateRequestsDelta`/`privateRequestsAbs` безусловно per-agent (схема не меняется, колонки уже per-`agent_id`)
- [x] 4.6 `FunnelResult.privateRequestsAbs`/`privateRequestsDelta` — вычислить один раз после основного цикла как `SUM` по `result.agents` (`null` → 0 в сумме); `null` только если весь шаг 4.3 недоступен целиком (`result.privateNote` установлен)
- [x] 4.7 `src/core/funnel-report.ts`: добавить столбец «Заяв» в текстовую таблицу (между «Отпр» и «Охват») и в строку «Итого», значение — `fmtDeltaAbs(a.privateRequestsDelta, a.privateRequestsAbs)` (уже даёт «—» при `abs == null`)
- [x] 4.8 `src/core/funnel-report.ts`: убрать отдельную строку `Заявки в приватный канал: …` под таблицей; оставить только строку `Заявки в приватный канал: недоступно (…)` при установленном `r.privateNote`
- [x] 4.9 `buildFunnelCsv`: добавить столбцы заявок по агенту (`заявки_дельта`, `заявки_абс`) в основную таблицу

## 5. US-5 — разбивка по каналам со ссылкой (CSV)

- [x] 5.1 `src/core/telegram/service.ts`: `listGroupChannels()` — вернуть `Map<string, { title: string; username: string | null }>` вместо `Map<string, string>` (username уже приходит в ответе `getDialogs`, сейчас отбрасывается)
- [x] 5.2 `src/core/db/channels.ts`: новая колонка `chatUsername TEXT` через аддитивную миграцию `migrateChatUsernameColumn` (по образцу `migrateChannelIdentityColumns`/`migrateCoverageColumns`), вызывается из `initChannels`
- [x] 5.3 `src/core/db/channels.ts` (`syncChannels`): расширить сигнатуру под новую Map (`{title, username}`), сравнивать оба поля в `toUpdate`, писать `chatUsername` при insert/update
- [x] 5.4 Обновить места вызова `listGroupChannels`/`syncChannels` под новую сигнатуру Map (сама передача Map дальше не меняется). **Уточнение по факту реализации:** `index.ts` больше не существует в кодовой базе (удалён отдельным изменением до этой сессии) — реальных вызывающих оказалось два, `monitor.ts` и `monitor-v2.ts`; оба уже совместимы без правок (Map передаётся насквозь, не распаковывается)
- [x] 5.5 `src/core/db/channels.ts`: `getChatTitlesAndUsernames(agentId, chatIds): Map<string, { title, chatUsername }>` — батч-select по списку `chatId`
- [x] 5.6 `src/core/db/channels.ts`: чистая функция `buildChannelUrl(chatId, chatUsername, msgId): string | null` — `t.me/<username>/<msgId>` при наличии username, иначе `t.me/c/<id без -100>/<msgId>` для `chatId` с префиксом `-100`, иначе `null`
- [x] 5.7 `src/core/funnel-collect.ts`: собрать `row.channelBreakdown` — для каждой записи `breakdown` (группа 3) подтянуть `title`/`chatUsername` через `getChatTitlesAndUsernames`, построить `url` через `buildChannelUrl(chatId, chatUsername, lastReplyMsgId)`
- [x] 5.8 `src/core/funnel-report.ts` (`buildFunnelCsv`): добавить вторую таблицу после пустой строки — `agent_id, канал, ссылка, сообщений_за_день`, по одной строке на `(agentId, chatId)` с ненулевым числом сообщений
- [x] 5.9 `src/core/funnel-report.ts`: добавить `csvEscapeField()` (RFC 4180 — кавычки при запятой/кавычке/переводе строки) для колонки «канал» (единственное текстовое поле произвольного содержания во всём CSV)
- [x] 5.10 Канал без определимой ссылки (`buildChannelUrl` вернул `null`) — строка всё равно попадает в разбивку, ячейка «ссылка» пустая (не пропускать строку)

## 6. Документация

- [x] 6.1 `docs/design/funnel-tracking/requirements-v3.md`: актуализировать предпосылку US-3 — создание персональных ссылок и таблица `agentId → ссылка` уже реализованы изменением `private-invite-links`, а не «отдельная ещё не выполненная задача»
- [x] 6.2 `docs/design/funnel-tracking/funnel-tracking-v2.md`: сверить §3 (формат отчёта) с фактическим результатом после реализации — при расхождении пометить документ как описывающий v2-базу, актуальный формат см. v3
