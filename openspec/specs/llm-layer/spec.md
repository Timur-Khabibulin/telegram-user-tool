# llm-layer Specification

## Purpose
TBD - created by archiving change task-scheduler. Update Purpose after archive.
## Requirements
### Requirement: codex через OAuth как primary
Вызовы LLM SHALL идти на подписке ChatGPT Plus через codex по OAuth, без потокенной оплаты за primary. Primary-провайдер — `openai-oauth-provider`, модель `gpt-5.4-mini` (зависит от плана Codex).

#### Scenario: Primary-вызов на подписке
- **WHEN** скилл вызывает `complete()` или `completeObject()`
- **THEN** запрос уходит на codex по OAuth-токену из `auth.json` ($0 для primary)

### Requirement: Единственный provider без failover

`LlmClient` SHALL оборачивать ровно одну модель (`codexProvider` на `gpt-5.4-mini`) через `createFallback` — вторая модель (`@ai-sdk/openai` по `OPENAI_API_KEY`) закомментирована в коде и не подключена. При ошибке/лимите primary запрос завершается ошибкой, автоматического переключения на другого провайдера сейчас нет.

#### Scenario: Rate-limit не переключает на другую модель
- **WHEN** primary (codex) возвращает 429 или ошибку
- **THEN** запрос завершается ошибкой; повторный успешный вызов возможен только после восстановления codex (нет второго провайдера в списке `createFallback`)

### Requirement: Автоматический рефреш токена с write-back
Рефреш токена SHALL выполняться автоматически без ручного вмешательства, включая сохранение обновлённого токена между запусками процессов. При `ensureFresh: true` (дефолт) перед запросом проверяется access token; если протух — `refreshChatGptTokens()` обновляет его, и свежие токены пишутся обратно в `auth.json` (`writeAuthFile` с `last_refresh`). Условие — файл записываемый пользователем `tg`.

#### Scenario: Коротко живущий диспетчер обновляет токен
- **WHEN** диспетчер стартует с протухшим access token в `auth.json`
- **THEN** токен рефрешится и записывается обратно; следующий процесс читает свежий токен

### Requirement: Общий auth.json на всех агентов
Один токен SHALL обслуживать всех агентов (общий пул лимита Plus). Файл — `~/.openclaw/codex-auth/auth.json`, в своей папке, отдельно от агентного `auth-profiles.json` OpenClaw. `LlmClient` указывает на него явно через `authFilePath`. Права: файл `chmod 600`, папка `codex-auth/` `700`, файл записываемый владельцем.

#### Scenario: Все агенты читают один файл
- **WHEN** несколько агентов вызывают LLM
- **THEN** все используют общий `~/.openclaw/codex-auth/auth.json` (общий пул лимита Plus)

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
OpenClaw. Файл читается заново на каждый вызов диспетчера (не копируется в
рабочую папку агента и не кэшируется между процессами).

#### Scenario: SOUL.md шаблона персоны как system-сообщение
- **WHEN** оркестрация вызывает `complete({ system: soul, prompt })`
- **THEN** `soul` прочитан из `~/.openclaw/personas/<personName>/SOUL.md`
  (`<personName>` — персона агента из `tg-account.json`) и передан как
  `system`, системные промпты OpenClaw не применяются

