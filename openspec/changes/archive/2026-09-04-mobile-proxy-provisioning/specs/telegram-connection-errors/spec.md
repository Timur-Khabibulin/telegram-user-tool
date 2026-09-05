## ADDED Requirements

### Requirement: Временный override прокси и бюджета попыток без изменения конфигурации аккаунта

`TelegramService.ensureClient()`/`requireClient()` SHALL принимать необязательный override —
прокси и/или бюджет попыток (число попыток, таймаут на попытку) — используемый вместо значений
из `AccountConfig`, загруженного `loadAccount()`. Override SHALL не читать и не изменять
`tg-account.json` — действует только на время конкретного вызова. Без override поведение SHALL
быть идентично поведению без этой возможности (обычный бюджет и прокси из персистентного
конфига аккаунта).

#### Scenario: Override не влияет на персистентный конфиг

- **WHEN** `ensureClient()` вызван с override-прокси, отличным от того, что записан в
  `tg-account.json`
- **THEN** соединение устанавливается с override-прокси, но `tg-account.json` не читается для
  прокси и не изменяется этим вызовом

#### Scenario: Классификация ошибок одинакова для override и обычного пути

- **WHEN** соединение с override-прокси не удаётся
- **THEN** бросается тот же набор классов ошибок (`ConnectTimeoutError`/`SessionRevokedError`/
  `MissingAccountConfigError`), что и при обычном подключении — отдельной ветки классификации
  для override нет

#### Scenario: Вызовы без override не меняют поведение

- **WHEN** `ensureClient()`/`requireClient()` вызваны без override-параметра
- **THEN** используются прокси и бюджет (`MAX_ATTEMPTS=3`, `CONNECT_TIMEOUT_MS=60_000`) из
  `AccountConfig`, как до появления этой возможности
