## ADDED Requirements

### Requirement: Запись ошибки отправки DM

Скилл `dm-send` SHALL записывать в таблицу `send_errors` (`chatId =
candidate.sourceChatId`, `occurredAt`, `source = 'dm_send'`, `errorCode`)
каждый исход ошибки `telegram_send_dm` (`peer_flood`, `flood_wait`,
`privacy_blocked`, `deactivated`, `peer_id_invalid` и любой иной), не изменяя
существующую логику управления потоком (`stopReason`, `floodErrors`,
переходы `break`/`continue`).

#### Scenario: peer_flood записывается перед остановкой прогона

- **WHEN** `telegram_send_dm` возвращает `{ error: 'peer_flood' }`
- **THEN** ошибка записывается в `send_errors` с `errorCode = 'peer_flood'`, после чего прогон завершается как и прежде (кандидат остаётся `pending`)

#### Scenario: flood_wait записывается на каждое повторение

- **WHEN** `telegram_send_dm` возвращает `{ error: 'flood_wait' }`
- **THEN** ошибка записывается в `send_errors` с `errorCode = 'flood_wait'` при каждом таком исходе, `floodErrors` увеличивается как и прежде

#### Scenario: privacy_blocked и deactivated записываются

- **WHEN** `telegram_send_dm` возвращает `{ error: 'privacy_blocked' }` или `{ error: 'deactivated' }`
- **THEN** ошибка записывается в `send_errors` с соответствующим `errorCode`, кандидат помечается как и прежде, цикл продолжается без паузы

#### Scenario: peer_id_invalid и прочие ошибки записываются

- **WHEN** `telegram_send_dm` возвращает `{ error: 'peer_id_invalid' }` или иную неизвестную ошибку
- **THEN** ошибка записывается в `send_errors` с этим `errorCode`, кандидат помечается `skipped` как и прежде

#### Scenario: Успешная отправка не пишет ошибку

- **WHEN** `telegram_send_dm` возвращает `{ ok: true }`
- **THEN** в `send_errors` ничего не записывается
