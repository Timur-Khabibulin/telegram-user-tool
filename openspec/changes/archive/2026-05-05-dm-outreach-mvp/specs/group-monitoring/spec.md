## MODIFIED Requirements

### Requirement: Agent scores and queues DM candidates
После обработки каждой группы агент SHALL оценивать интересные сообщения на потенциал для DM по шкале 0.0–1.0 и записывать кандидатов в `dm_candidates`, если `score >= 0.6`. Запись происходит в конце шага обработки группы, после отправки ответов в группу.

Критерии оценки:
- 0.9–1.0: сильный личный вопрос, явная экспертиза, живой интерес к теме канала
- 0.6–0.8: есть зацепка, но повод для DM не очевиден
- ниже 0.6: пропустить, не записывать

Поля для записи: `userId`, `userAccessHash` (из поля сообщения, только если не min-entity), `sourceChatId`, `msgId`, `msgText`, `score`, `scoreReason`.

Агент SHALL НЕ отправлять DM непосредственно из этого скилла.

#### Scenario: High-score message queued
- **WHEN** агент нашёл сообщение с оценкой ≥ 0.6 и у пользователя есть `userAccessHash`
- **THEN** вызывается `dm_candidates_insert` с полными данными; DM не отправляется

#### Scenario: Low-score message skipped
- **WHEN** агент оценил сообщение ниже 0.6
- **THEN** `dm_candidates_insert` не вызывается для этого сообщения

#### Scenario: min-entity user — queued without accessHash
- **WHEN** `userAccessHash` отсутствует (min-entity)
- **THEN** запись всё равно создаётся, но `userAccessHash` = null; Cron 2 не сможет отправить DM такому кандидату

#### Scenario: Duplicate message not duplicated
- **WHEN** одно и то же сообщение встречается на двух прогонах (одинаковые `sourceChatId`, `msgId`)
- **THEN** второй вызов `dm_candidates_insert` молча игнорируется (ON CONFLICT IGNORE)
