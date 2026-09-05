## MODIFIED Requirements

### Requirement: Structured output для скоринга и выбора сообщений

Валидируемый JSON SHALL поддерживаться для скоринга и выбора сообщений. JSON-вызовы идут
через `completeObject()` со схемой `zod`; текстовые — через `complete()`. Каталог промптов:
`generateDM`, `generateThreadReply`, `generateReply`, `extractTopics` (текст),
`selectRelevantMessage` (JSON `{ id }`), `scoreForDM` (JSON `{ score, reason }`),
`scoreTopicRelevance` (JSON `{ theses, channelTopic, score, reason }`), `generateDmReply`
(текст).

#### Scenario: JSON-вывод валидируется схемой

- **WHEN** вызывается `selectRelevantMessage`, `scoreForDM` или `scoreTopicRelevance`
- **THEN** результат возвращается как валидируемый JSON по схеме `zod` через `completeObject()`

#### Scenario: Оценка тематической релевантности по описанию и постам канала

- **WHEN** вызывается `scoreTopicRelevance` с темой прогона, описанием канала и текстами
  последних постов
- **THEN** возвращается `{ theses, channelTopic, score, reason }`, где `theses` — тезис по
  каждому посту, `channelTopic` — основная тема канала (короткая фраза), `score` — число в
  диапазоне `0..1` (доля контента канала по теме прогона), валидируемое схемой `zod`

#### Scenario: Невалидный JSON

- **WHEN** structured-вывод невалиден
- **THEN** повтор/ошибка на уровне `generateObject`
