## 1. ProxyConfig — персистентная локация

- [x] 1.1 Добавить `countryCode?: string`, `state?: string`, `city?: string` в `ProxyConfig`
      (`src/core/config.ts`)
- [x] 1.2 Расширить парсинг прокси в `loadAccountConfig` (`src/core/config.ts`) — читать
      `countryCode/state/city` из `tg-account.json`, не терять их как неизвестные поля

## 2. asocks-client — списки для пошагового подбора

- [x] 2.1 Вынести листинг стран в `listCountries(apiKey): Promise<DirEntry[]>`
      (`src/core/proxy/asocks-client.ts`)
- [x] 2.2 Вынести листинг регионов в `listStates(apiKey, countryId): Promise<DirEntry[]>`
- [x] 2.3 Вынести листинг городов в `listCities(apiKey, stateId): Promise<DirEntry[]>`
- [x] 2.4 Переписать `resolveLocation`, чтобы она переиспользовала `listCountries/listStates/
      listCities` вместо дублирования HTTP-вызовов

## 3. TelegramService — проверка прокси без сессии

- [x] 3.1 Добавить `probeProxy(params: { apiId, apiHash, proxy }): Promise<void>` в
      `TelegramService` (`src/core/telegram/service.ts`) — только `client.connect()` +
      `disconnect()`, без `Api.auth.SendCode`; бросает те же классы ошибок подключения
      (`ConnectTimeoutError`/`SessionRevokedError`), что `ensureClient`, где это применимо
- [x] 3.2 Убедиться, что `probeProxy` не использует и не требует `resolveAccountConfig`/
      `sessionString` (агента ещё не существует на этом этапе)

## 4. Create-флоу: подбор прокси до сессии

- [x] 4.1 Новый скрипт (например `src/scripts/provision-proxy-for-new-agent.ts`): цикл
      create-кандидат (asocks) → `probeProxy` → при неудаче `deleteProxyByName` → следующий
      кандидат, до `--max-attempts` (по умолчанию 5)
- [x] 4.2 Скрипт поддерживает ввод локации: либо явные `--country/--state/--city`, либо флаги
      листинга для пошагового режима (`--list-countries`, `--list-states <countryCode>`,
      `--list-cities <countryCode> <state>`) — вызываются отдельно, до основного цикла
- [x] 4.3 При успехе скрипт выводит подтверждённые `host/port/username/password/name/
      countryCode/state/city` (для записи в `tg-account.json` на следующем шаге создания
      агента); при исчерпании попыток — явный отчёт о неудаче, без побочных эффектов

## 5. Скаффолд файловой структуры агента

- [x] 5.1 Новый скрипт `skills/tg-agent-create/scripts/create-agent-scaffold.sh` (по образцу
      `verify-agent.sh`): `openclaw agents add`, вычисление и установка индекса биндинга,
      `mkdir` agent-dir, копирование `auth-profiles.json`/`models.json` из `main`, создание
      `AGENTS.md`, `touch` пустых workspace-файлов — один вызов вместо текущей
      последовательности bash-команд
- [x] 5.2 Скрипт идемпотентен и не портит уже существующего агента с тем же именем (явная
      проверка перед созданием, аналогично проверкам в `verify-agent.sh`)

## 6. SOUL.md — копия эталона

- [x] 6.1 Определить эталонный путь `~/.openclaw/workspace-agent1/SOUL.md` как источник для
      копирования (без изменений в коде — это конвенция, задокументированная в SKILL.md)

## 7. `skills/tg-agent-create/SKILL.md` — переписать флоу

- [x] 7.1 Убрать из Шага 1 ввод `proxy.host/port/username/password`; добавить выбор режима
      локации прокси (готовые значения / пошаговый подбор) и вызов скриптов из раздела 4.2 для
      показа списков в пошаговом режиме
- [x] 7.2 Вставить шаг вызова скрипта из раздела 4 (подбор прокси) до шага авторизации сессии
      (`tg_auth_send_code`/`tg_auth_sign_in`), сохранив `allowFrom` на прежнем месте (сразу после
      сбора данных, до создания структуры агента)
- [x] 7.3 Заменить последовательность bash-команд создания структуры агента на один вызов
      скрипта из раздела 5
- [x] 7.4 Заменить шаг запроса текста `SOUL.md` у юзера на копирование эталонного файла (раздел
      6), с сохранением возможности явно указать другую персону, если юзер попросит
- [x] 7.5 Обновить запись `tg-account.json` (Шаг 5 текущего SKILL.md) — включить
      `countryCode/state/city` из подтверждённого прокси

## 8. Репейр-скилл `mobile-proxy-provision` — опциональная локация

- [x] 8.1 `src/scripts/provision-mobile-proxy.ts`: если `--country`/`--state`/`--city` не
      переданы явно, брать значения из `account.proxy?.countryCode/state/city` (уже загруженного
      `AccountConfig` агента)
- [x] 8.2 `saveProxyToAccountConfig` (`provision-mobile-proxy.ts`) сохраняет `countryCode/state/
      city` вместе с остальными полями прокси при подтверждённом успехе
- [x] 8.3 Если ни явных флагов, ни сохранённых значений нет — явная ошибка с понятным сообщением
      (нужна хотя бы страна), а не молчаливый сбой
- [x] 8.4 Обновить `.claude/skills/mobile-proxy-provision/SKILL.md` — таблица входных параметров:
      страна/регион/город помечены не обязательными, с пояснением про дефолт из `tg-account.json`

## 9. Проверка

- [x] 9.1 Обновить `docs/configuration.md`/`docs/operation.md`, если формат `tg-account.json`
      или процедура создания агента там описаны явно
