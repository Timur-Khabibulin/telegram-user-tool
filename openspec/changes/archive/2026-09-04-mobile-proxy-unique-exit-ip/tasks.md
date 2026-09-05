## 1. Клиент asocks: `src/core/proxy/asocks-client.ts`

- [x] 1.1 `searchMobileProxies(apiKey, countryCode, limit, log)` — `GET /v2/proxy/search`
      (`country`+`types[]=mobile`+`limit`), парсинг ответа (первый элемент — `{success}`,
      остальные — строки вида `http://login:pass@host:port`) в массив
      `{ host, port, username, password }`
- [x] 1.2 Лимит зафиксирован константой `SEARCH_LIMIT=5000` в `proxy-pool.ts` — эндпоинт не
      пагинирует, весь пул (1642 для US) приходит одним ответом при таком запасе
- [x] 1.3 `createMobileProxy`/`deleteProxyByName`/`resolveLocation`/`listStates`/`listCities` —
      не тронуты (используются другими сценариями вне скоупа этой работы)

## 2. Сверка занятости

- [x] 2.1 `listUsedProxyUsernames()` (`src/core/config.ts`) — обходит `workspace-*/tg-account.json`
      через `listAgentIds()`, собирает непустые `proxy.username`, best-effort (битый конфиг не
      блокирует остальных)
- [x] 2.2 `fetchAvailableMobileProxies`/`createProxyPicker` (`src/core/proxy/proxy-pool.ts`) —
      `searchMobileProxies` минус `listUsedProxyUsernames()`, `takeNext()` явно возвращает `null`
      при исчерпании (вызывающий код проверяет `null` отдельно от прочих ошибок)

## 3. `src/scripts/provision-mobile-proxy.ts` (репейр существующих агентов)

- [x] 3.1 Цикл заменён: один `fetchAvailableMobileProxies` на страну (кэшируется в `Map` на весь
      прогон, общий для всех агентов списка — уже выданный кандидат не предложится следующему
      агенту), `createProxyPicker().takeNext()` вместо `createMobileProxy`, никакого
      `deleteProxyByName`
- [x] 3.2 Решено: шаг «кандидат №0» сохранён, но условие сменено с `proxy?.name` на
      `proxy?.host && proxy?.username` (есть хоть какой-то настроенный прокси) — новые кандидаты
      `name` не имеют, оптимизация «не трогать рабочий прокси» от источника не зависит
- [x] 3.3 CLI: `--name-template`/`--state`/`--city` убраны, остались `--agents`/`--country`/
      `--max-attempts`
- [x] 3.4 Итоговый отчёт показывает `host:port` без имени; добавлен статус `pool_exhausted`
      (отдельно от `not_found`, см. mobile-proxy-provisioning spec «Пул кандидатов страны
      исчерпан»)

## 4. `src/scripts/provision-proxy-for-new-agent.ts` (создание нового агента, 3 режима)

- [x] 4.1 Режим auto-probe (v1, `probeProxy`): переведён на `fetchAvailableMobileProxies`, без
      создания/удаления, добавлен явный `poolExhausted` в результат неудачи
- [x] 4.2 Решено (см. design.md, снят с Open Questions): `--delete-candidate` удалён из CLI;
      вместо него `--create-candidate` принимает `--exclude <login1,login2,...>` — логины,
      отвергнутые в более ранних попытках этого же прогона, накапливает вызывающая сторона
      (в памяти, между stateless-вызовами скрипта)
- [x] 4.3 `--list-states`/`--list-cities` удалены из `provision-proxy-for-new-agent.ts`;
      `--list-countries` оставлен без изменений
- [x] 4.4 `proxy-selection.ts` потребовал изменений (сигнатура `createProxyCandidate` — теперь
      `(agentId, region, exclude, log)` вместо `(agentId, attempt, region, log)`,
      `deleteProxyCandidate` удалён): `selectWorkingProxy` копит `rejected: string[]` в замыкании
      цикла и передаёт его каждой следующей попытке через `--exclude`. Публичная сигнатура
      `selectWorkingProxy` не изменилась — вызывающий код в `run.ts` правок не потребовал

## 5. Skills

- [x] 5.1 `skills/tg-agent-create/SKILL.md`: пошаговый выбор региона/города убран, остался выбор
      страны (готовое значение либо список `/dir/countries`); JSON-примеры и финальное сообщение
      обновлены (без `name`/`state`/`city`)
- [x] 5.2 `.claude/skills/mobile-proxy-provision/SKILL.md`: входные параметры и пример вызова
      обновлены (без региона/города/`--name-template`), добавлено описание статуса «пул
      исчерпан»
- [x] 5.3 (сверх исходного плана, но в скоупе того же изменения) `skills/tg-agent-create-v2/
      SKILL.md`: тот же выбор только страны, `--create-candidate`/`--exclude` вместо
      `--create-candidate --attempt`/`--delete-candidate`, обработка `poolExhausted`, JSON/
      финальное сообщение без `name`/`state`/`city`

## 6. Проверка

- [x] 6.1 Задеплоено на VPS. Прогнано на забаненном `agent1799`: кандидат №0 (существующий
      `hold-query` прокси) по-прежнему подтверждается штатно; при принудительном отсутствии
      сохранённого прокси взят кандидат из `/proxy/search` (1604 доступно для `US`),
      MTProto-подключение прошло с первой попытки (`connected as Катя`), в `tg-account.json`
      сохранилась ожидаемая форма — `type/host/port/username/password/countryCode`, без
      `name`/`state`/`city`. Заодно наблюдение: кандидаты `/proxy/search`, в отличие от
      `create-port`-dedicated из прошлой диагностики (2026-08-26), не показали зависания при
      MTProto-подключении — подключились с первой попытки. Агент восстановлен из бэкапа после
      теста
- [x] 6.2 Проверено отдельным прогоном чистой логики (без MTProto): `createProxyPicker` на пуле
      из 3 кандидатов корректно вернул `null` на 4-м вызове `takeNext()` — исчерпание
      определяется явно, не тихим `undefined`. `listUsedProxyUsernames()` на проде вернул 28
      занятых логинов (все — старого формата `hold-query`, ни один пока не пересекается с
      каталогом `/proxy/search` — ожидаемо, ни один агент ещё не мигрирован на новый источник)
