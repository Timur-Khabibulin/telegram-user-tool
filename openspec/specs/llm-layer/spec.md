# llm-layer Specification

## Purpose
TBD - created by archiving change task-scheduler. Update Purpose after archive.
## Requirements
### Requirement: codex-подписка как primary через @openai-oauth/ai-sdk

Primary LLM SHALL идти на ChatGPT-подписку через `@openai-oauth/ai-sdk`
(`createOpenAIOAuth(openaiCredentials({ authFilePath }))`), модель `gpt-5.6-sol`.
Библиотека шлёт корректный codex-`originator`, поэтому запросы проходят гейтинг
codex-бэкенда. Персона передаётся как `system` (доставка в codex — через механизм
библиотеки).

#### Scenario: Primary-вызов на codex

- **WHEN** скилл вызывает `complete()` или `completeObject()` и codex доступен
- **THEN** запрос уходит на `gpt-5.6-sol` через `@openai-oauth/ai-sdk` на подписке
  (без потокенной оплаты)

### Requirement: codex-токен из общего auth.json с авто-рефрешем

Primary SHALL использовать общий `~/.openclaw/codex-auth/auth.json` (один codex-токен
на все вызовы и всех агентов); рефреш access-token выполняет `@openai-oauth/ai-sdk`
автоматически. Каталог `~/.openclaw/codex-auth/` не удаляется.

#### Scenario: Токен обновляется автоматически

- **WHEN** access-token в `auth.json` протух
- **THEN** библиотека рефрешит его без ручного вмешательства, вызов проходит

### Requirement: DeepSeek как fallback на любую ошибку primary

При **любой** ошибке primary (codex) вызов SHALL автоматически повторяться на
DeepSeek (`deepseek-flash`) через `ai-fallback` (`createFallback([primary, fallback])`).

#### Scenario: Ошибка codex переключает на DeepSeek

- **WHEN** primary (codex) возвращает любую ошибку (авторизация/гейтинг/лимит/сеть)
- **THEN** тот же вызов исполняется fallback-моделью `deepseek-flash`; при её успехе
  результат возвращается штатно

#### Scenario: Оба провайдера недоступны

- **WHEN** и codex, и DeepSeek возвращают ошибку
- **THEN** вызов завершается ошибкой (как при единственном провайдере)

### Requirement: Срабатывание фолбэка логируется

Каждое переключение primary→fallback SHALL логироваться (с причиной — текстом ошибки
primary) в stdout/stderr (journald), чтобы отказ codex и переход на платный DeepSeek
не были тихими.

#### Scenario: Фолбэк виден в логах

- **WHEN** сработал фолбэк на DeepSeek
- **THEN** в journald есть запись с причиной срабатывания (ошибкой primary)

### Requirement: Аутентификация fallback-провайдера статическим API-ключом

Fallback (DeepSeek) SHALL аутентифицироваться статическим ключом `DEEPSEEK_API_KEY`
из окружения процесса (загружается из `~/.openclaw/secrets.env` через systemd
`EnvironmentFile`), один ключ на всех агентов. Ключ обязателен — при его отсутствии
`createLlmClient` завершается ошибкой конфигурации.

#### Scenario: Ключ отсутствует

- **WHEN** `DEEPSEEK_API_KEY` не задан в окружении
- **THEN** `createLlmClient` бросает явную ошибку конфигурации, а не тихо теряет fallback

### Requirement: Structured output для скоринга и выбора сообщений

Валидируемый JSON SHALL поддерживаться для скоринга и выбора сообщений. JSON-вызовы идут
через `completeObject()` со схемой `zod`; текстовые — через `complete()`. Каталог промптов:
`generateDM`, `generateThreadReply`, `generateReply`, `extractTopics`, `analyzeAndReply`
(текст, `dm-replies`); `analyzeChannelMessages` (JSON, выбор общего сообщения для ответа +
DM-скоринг одним вызовом, `monitor`/`monitor-v2`/`monitor-v5`), `selectRelevantMessageInBatch`
(JSON `{ chatId, id }`, `account-warmup`), `scoreTopicRelevance` (JSON `{ theses, channelTopic,
score, reason }`, `discovery/similar`).

#### Scenario: JSON-вывод валидируется схемой

- **WHEN** вызывается `analyzeChannelMessages`, `selectRelevantMessageInBatch` или `scoreTopicRelevance`
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

### Requirement: Персона из общего шаблона без системных промптов OpenClaw
Персона SHALL браться из общего шаблона `~/.openclaw/personas/<personName>/
SOUL.md`, где `<personName>` — значение поля `persona` из `tg-account.json`
агента, и передаваться как `system`-сообщение — без системных промптов
OpenClaw. Файл читается заново на каждый прогон диспетчера (не копируется в
рабочую папку агента и не кэшируется между процессами).

#### Scenario: SOUL.md шаблона персоны как system-сообщение
- **WHEN** оркестрация вызывает `complete({ system: soul, prompt })`
- **THEN** `soul` прочитан из `~/.openclaw/personas/<personName>/SOUL.md`
  (`<personName>` — персона агента из `tg-account.json`) и передан как
  `system`, системные промпты OpenClaw не применяются
