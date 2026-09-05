## MODIFIED Requirements

### Requirement: Монитор различает CHAT_WRITE_FORBIDDEN

При не-flood ошибке отправки ответа монитор SHALL отдельно распознавать
`CHAT_WRITE_FORBIDDEN` и для этого случая помечать канал `status = 'banned'`
(`markChannelStatus`), помимо существующей записи ошибки и пропуска канала.
Постановка в отдельную очередь `banned_channels` SHALL не выполняться —
источником очереди на выход служит сам `channels.status` (capability
`leave-banned-channels`). Прочие не-flood ошибки ответа (не
`CHAT_WRITE_FORBIDDEN`) SHALL обрабатываться как прежде — без изменения
`status` канала на `banned`.

#### Scenario: CHAT_WRITE_FORBIDDEN помечает статус канала

- **WHEN** отправка ответа в канале завершается ошибкой `CHAT_WRITE_FORBIDDEN`
- **THEN** `channels.status` для этого `chatId` устанавливается в `'banned'`, канал помечается обработанным, прогон продолжается со следующего канала

#### Scenario: Прочая не-flood ошибка не меняет статус на banned

- **WHEN** отправка ответа завершается не-flood ошибкой, отличной от `CHAT_WRITE_FORBIDDEN`
- **THEN** канал пропускается как прежде, `status` канала не устанавливается в `'banned'`

#### Scenario: Повторный FLOOD_WAIT не затрагивается

- **WHEN** отправка ответа завершается повторным `FLOOD_WAIT` (`FloodAbortError`)
- **THEN** весь прогон прерывается как прежде, `status` канала не изменяется
