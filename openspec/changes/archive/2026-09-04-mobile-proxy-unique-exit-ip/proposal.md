## Why

Разбор коллизии прокси у агентов с включённым `monitor-v5` (2026-08-25/26) показал: у агентов
188/204/208 и ещё 6 групп совпадали `host+port+username+password` — Telegram видел один и тот же
внешний IP для нескольких разных аккаунтов одновременно. Причина — `createMobileProxy()`
(`src/core/proxy/asocks-client.ts`) запрашивает прокси у asocks с таргетингом до
`state`/`city` (в проде — всегда одна точка, Флорида/Майами), а инвентарь мобильных устройств
asocks под конкретный город на этом аккаунте — единицы (эмпирически: 5 попыток `create-port` с
`server_port_type_id=DEDICATED` дали exit IP `12.75.74.65`/`99.27.15.209`/`172.59.69.86` —
повторяющиеся значения из маленького набора, независимо от того, shared или dedicated
запрошен порт). Правка типа порта (`type_id=KEEP PROXY`, `server_port_type_id=DEDICATED`,
2026-08-26) не решает проблему — она снижает вероятность коллизии, но не убирает её, потому что
упирается в тот же маленький пул устройств одного города.

Найден `GET /v2/proxy/search` (`country`+`types[]=mobile`+`limit`, без `state`/`city`) — отдаёт
готовый перечислимый список уже существующих прокси-сессий аккаунта. Проверено напрямую:
1642 уникальных логина для `country=US, types=mobile` (при `create-port` под Майами — единицы);
список стабилен между вызовами (одинаковый состав, только порядок рандомизирован); каждый логин
даёт свой стабильный exit IP при повторных подключениях (не ротирует, в отличие от
`hold-query`-логинов `create-port`). Это даёт возможность гарантировать, а не просто удешевить,
уникальность прокси между агентами: перед выдачей кандидата явно проверять, что его логин ещё не
используется ни одним другим агентом.

## What Changes

- `src/core/proxy/asocks-client.ts`: новая функция `searchMobileProxies(apiKey, countryCode,
  limit, log)` — обёртка над `GET /proxy/search?country=<cc>&types[]=mobile&limit=<n>`, парсит
  ответ в список `{ host, port, username, password }`. `createMobileProxy`/`deleteProxyByName`
  (обёртки над `create-port`/`delete-port`) не удаляются — используются другими сценариями (не
  входят в скоуп этого change), но новый мобильный поток подбора их больше не вызывает.
- Новая функция сверки занятости (точное расположение — на реализации; логически рядом с
  `listAgentIds()`/конфигом): собрать `proxy.username` из `tg-account.json` **всех** агентов
  (`workspace-*/`), исключить эти логины из списка `searchMobileProxies`, взять первый оставшийся.
- `src/scripts/provision-mobile-proxy.ts` (репейр существующих агентов): цикл
  «create-port → verify → delete-if-bad» заменяется на «взять следующий неиспользуемый логин из
  уже полученного списка `/proxy/search` → verify → при неудаче взять следующий» — без DELETE
  (ресурс не наш, мы его не создавали). CLI теряет `--name-template`/`--state`/`--city`, остаётся
  `--country`/`--max-attempts`.
- `src/scripts/provision-proxy-for-new-agent.ts` (создание нового агента, 3 режима — auto-probe,
  create/delete-candidate, list-*): та же замена источника кандидатов. Режим `--delete-candidate`
  теряет смысл (нечего удалять) — заменяется на неявный пропуск при повторном
  `--create-candidate` в рамках того же прогона. `--list-states`/`--list-cities` выводятся из
  мобильного потока (у `/proxy/search` нет этих фильтров); `--list-countries` остаётся.
- `src/core/tg-agent-autoregistration/proxy-selection.ts`: без структурных изменений — вызывает
  `provision-proxy-for-new-agent.ts --create-candidate`, наследует новое поведение автоматически.
- `skills/tg-agent-create/SKILL.md`, `.claude/skills/mobile-proxy-provision/SKILL.md`: убрать
  пошаговый выбор региона/города, оставить только выбор страны.
- `ProxyConfig.state/city` (`src/core/config.ts`) — поля остаются в типе (уже существующие
  агенты хранят их), но новые подборы их больше не заполняют.

## Capabilities

### Modified Capabilities

- `mobile-proxy-provisioning`: источник кандидатов — `/proxy/search` (страна+тип), не
  `create-port` (страна+регион+город); кандидат — существующий ресурс аккаунта, не создаётся и не
  удаляется; добавлена гарантия уникальности логина между агентами.
- `tg-agent-create`: шаг выбора локации сужается до страны (пошаговый подбор региона/города
  убирается); подбор прокси до авторизации сессии использует тот же новый источник кандидатов.
- `tg-agent-create-v2`: то же сужение локации; ручная проверка кандидата человеком — цикл
  «выдать → дождаться ответа → при неудаче взять следующий» без удаления на стороне asocks.
- `tg-agent-autoregistration`: подбор прокси на аккаунт наследует новый источник кандидатов через
  `provision-proxy-for-new-agent.ts`, без собственных структурных изменений.

## Impact

- Код: `src/core/proxy/asocks-client.ts`, `src/scripts/provision-mobile-proxy.ts`,
  `src/scripts/provision-proxy-for-new-agent.ts`, `skills/tg-agent-create/SKILL.md`,
  `.claude/skills/mobile-proxy-provision/SKILL.md`.
- Данные: `ProxyConfig.state/city` не удаляются из типа (обратная совместимость с уже
  существующими `tg-account.json`), просто перестают заполняться для новых подборов.
- Вне скоупа (см. design.md Non-Goals): починка тихого зависания `ensureClient` при обрыве
  MTProto-соединения (найдено 2026-08-26, разбор отложен явным решением пользователя);
  расширение подбора на несколько стран одновременно (`/proxy/search` это поддерживает —
  `country=US.KZ`, но не требуется сейчас); повторный провижининг уже существующих агентов с
  коллизией — операционная задача после реализации, не часть этого change.
