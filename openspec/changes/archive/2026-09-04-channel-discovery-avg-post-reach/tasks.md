## 1. tgstat.ts — новая функция getChannelStat

- [x] 1.1 Добавить интерфейс `TgstatChannelStat { avgPostReach: number }` в `src/core/discovery/tgstat.ts`
- [x] 1.2 Реализовать `getChannelStat(tgId: number, token: string, log: Logger): Promise<TgstatChannelStat>` через существующий `callApi("channels/stat", ...)`
- [x] 1.3 Обновить комментарий-шапку `tgstat.ts`: добавить `channels/stat` в список методов, убрать строку «channels/stat не запрашиваем»

## 2. run.ts — новый параметр и гейт (TGStat)

- [x] 2.1 Добавить `minAvgPostReach?: number` в интерфейс `RunParams`
- [x] 2.2 Добавить `rejectedByAvgReach: number` и `minAvgPostReach?: number` в интерфейс `RunResult`
- [x] 2.3 Вставить гейт в цикл `runDiscovery` после гейта `participantsCount`: fail-closed при `tgId == null`, при ошибке `getChannelStat`, при `avgPostReach <= minAvgPostReach`
- [x] 2.4 Обновить `renderReport`: добавить строку `• отсеяно по охвату: N` если `r.minAvgPostReach != null`

## 3. scripts/discovery.ts — новый флаг CLI

- [x] 3.1 Добавить парсинг `--min-avg-reach` через `parseArg`
- [x] 3.2 Передать `minAvgPostReach: minAvgReach != null ? Number(minAvgReach) : undefined` в `runDiscovery`

## 4. SKILL.md — параметр min_avg_post_reach

- [x] 4.1 Добавить `min_avg_post_reach` как необязательный параметр в шаг 1 (`skills/channel-discovery/SKILL.md`)
- [x] 4.2 Добавить передачу `minAvgPostReach` в вызов `tg_discovery_run` в шаге 3 (если задан оператором)

## 5. telegram/service.ts — метод для MTProto fallback

- [x] 5.1 Добавить метод `getChannelAvgPostReach(username: string, limit: number, log: Logger): Promise<number>` в `TelegramService`: получить `limit` последних постов канала по username, вычислить среднее `views`. Если постов нет — вернуть 0.

## 6. run.ts — MTProto fallback

- [x] 6.1 Добавить `avgReachAgentId?: string` и `telegramService?: TelegramService` в интерфейс `RunParams`
- [x] 6.2 Обновить гейт в `runDiscovery`: при ошибке `channels/stat` или `tgId == null` — если `avgReachAgentId` задан и `telegramService` передан — вызвать `telegramService.getChannelAvgPostReach(username, 10, log)`; при ошибке MTProto или отсутствии `avgReachAgentId` — fail-closed
- [x] 6.3 Парсинг username из `c.link`: если invite-ссылка (`t.me/+…`) — сразу fail-closed без MTProto

## 7. index.ts — новый параметр avgReachAgentId

- [x] 7.1 Добавить `avgReachAgentId: Type.Optional(Type.String(...))` в параметры тула `tg_discovery_run`
- [x] 7.2 Загрузить аккаунт `telegramService.loadAccount(params.avgReachAgentId)` и передать `telegramService` и `avgReachAgentId` в `runDiscovery`

## 8. scripts/discovery.ts — новый флаг --avg-reach-agent

- [x] 8.1 Добавить парсинг `--avg-reach-agent` через `parseArg`
- [x] 8.2 Если задан — создать `TelegramService`, загрузить аккаунт, передать в `runDiscovery`

## 9. SKILL.md — параметр avg_reach_agent

- [x] 9.1 Добавить `avg_reach_agent` как необязательный параметр в шаг 1 (`skills/channel-discovery/SKILL.md`)
- [x] 9.2 Добавить передачу `avgReachAgentId` в вызов `tg_discovery_run` в шаге 3 (если задан оператором)
