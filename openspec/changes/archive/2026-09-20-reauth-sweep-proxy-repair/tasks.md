## 1. Вынос переиспользуемых функций подбора прокси

- [x] 1.1 Вынести `saveProxyToAccountConfig` и `toProxyConfig` из `src/scripts/ops/provision-mobile-proxy.ts` в общий модуль `src/features/proxy/` (напр. `provision-shared.ts`), обновить импорт в `provision-mobile-proxy.ts` без изменения его поведения
- [x] 1.2 Добавить `parseProxyCountry(username, fallbackCountryCode)` в `src/features/proxy/` — регексп `mobile-country-([A-Z]{2})` с фолбэком на `proxy.countryCode`, возврат `null` если страна не определена

## 2. Подбор прокси через tdata

- [x] 2.1 Реализовать `provisionProxyViaTdata(agentId, country, maxCandidates, log): Promise<ProxyConfig | null>` в `src/features/proxy/` поверх `fetchAvailableMobileProxies` + `createProxyPicker` (proxy-pool.ts) и `connectBootstrap` (core/tdata): перебор до `maxCandidates`, при успешном `connectBootstrap` — `disconnect`, запись прокси в `tg-account.json` и возврат прокси; при исчерпании — `null`
- [x] 2.2 Убедиться, что при неуспехе всех кандидатов `tg-account.json` не изменяется (запись только при подтверждённом подключении)

## 3. Интеграция в свип

- [x] 3.1 В `runReauthSweep` (`src/features/agent-reauth-sweep/run.ts`) добавить счётчик агентов-на-починку за прогон (лимит 5)
- [x] 3.2 В ветке `case "connect_failed"`: если лимит не исчерпан и страна определяется (`parseProxyCountry`) — вызвать `provisionProxyViaTdata(agentId, country, 10, log)`; иначе прежняя транзиентная обработка
- [x] 3.3 При найденном прокси — инкремент счётчика, повторный `reauthFromTdata(agentId)`, применение исхода повтора по существующей карте исходов (тот же `switch`)
- [x] 3.4 При ненайденном прокси / неопределённой стране / исчерпанном лимите — прежняя транзиентная обработка (строка `agent_restrictions` не меняется)
- [x] 3.5 Логировать в journal: попытку замены, выбранный прокси/причину отказа, исход повторной реавторизации (наблюдаемость только через systemd-журнал, без Saved Messages)

## 4. Проверка

- [x] 4.1 `tsc --noEmit` — типы чисты
