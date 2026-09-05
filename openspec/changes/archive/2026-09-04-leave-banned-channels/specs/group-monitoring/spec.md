## ADDED Requirements

### Requirement: Монитор различает CHAT_WRITE_FORBIDDEN

При не-flood ошибке отправки ответа монитор SHALL отдельно распознавать
`CHAT_WRITE_FORBIDDEN` и для этого случая ставить `chatId` в очередь
`banned_channels` (`INSERT OR IGNORE`), помимо существующей записи ошибки и
пропуска канала. Прочие не-flood ошибки ответа (не `CHAT_WRITE_FORBIDDEN`) SHALL
обрабатываться как прежде — без постановки в `banned_channels`.

#### Scenario: CHAT_WRITE_FORBIDDEN ставит канал в очередь

- **WHEN** отправка ответа в канале завершается ошибкой `CHAT_WRITE_FORBIDDEN`
- **THEN** `chatId` добавляется в `banned_channels`, канал помечается обработанным, прогон продолжается со следующего канала

#### Scenario: Прочая не-flood ошибка не ставит канал в очередь

- **WHEN** отправка ответа завершается не-flood ошибкой, отличной от `CHAT_WRITE_FORBIDDEN`
- **THEN** канал пропускается как прежде, в `banned_channels` ничего не добавляется

#### Scenario: Повторный FLOOD_WAIT не затрагивается

- **WHEN** отправка ответа завершается повторным `FLOOD_WAIT` (`FloodAbortError`)
- **THEN** весь прогон прерывается как прежде, в `banned_channels` ничего не добавляется
