## ADDED Requirements

### Requirement: codex через OAuth как primary
Вызовы LLM SHALL идти на подписке ChatGPT Plus через codex по OAuth, без потокенной оплаты за primary. Primary-провайдер — `openai-oauth-provider`, модель `gpt-5.4` (зависит от плана Codex).

#### Scenario: Primary-вызов на подписке
- **WHEN** скилл вызывает `complete()` или `completeObject()`
- **THEN** запрос уходит на codex по OAuth-токену из `auth.json` ($0 для primary)

### Requirement: Failover при лимите
Если codex упирается в лимит/ошибку, запрос SHALL автоматически уходить на другую модель. `ai-fallback` оборачивает список моделей в одну; при ошибке primary зовёт следующую (`@ai-sdk/openai` по `OPENAI_API_KEY`). Через `shouldRetryThisError` можно сузить переключение до «только лимит».

#### Scenario: Rate-limit переключает на fallback
- **WHEN** primary (codex) возвращает 429 или ошибку
- **THEN** `ai-fallback` зовёт следующую модель из списка

#### Scenario: Сбой авторизации
- **WHEN** refresh token истёк и вызов codex падает
- **THEN** `ai-fallback` уходит на запасную модель; система не встаёт, codex возвращается после повторного `codex login`

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

### Requirement: Персона из SOUL.md без системных промптов OpenClaw
Персона SHALL браться из `SOUL.md` агента (`~/.openclaw/agents/<agentName>/agent/SOUL.md`) и передаваться как `system`-сообщение — без системных промптов OpenClaw.

#### Scenario: SOUL.md как system-сообщение
- **WHEN** оркестрация вызывает `complete({ system: soul, prompt })`
- **THEN** `soul` прочитан из `SOUL.md` агента и передан как `system`, системные промпты OpenClaw не применяются

### Requirement: Structured output для скоринга и выбора сообщений
Валидируемый JSON SHALL поддерживаться для скоринга и выбора сообщений. JSON-вызовы идут через `completeObject()` со схемой `zod`; текстовые — через `complete()`. Каталог промптов: `generateDM`, `generateThreadReply`, `generateReply`, `extractTopics` (текст), `selectRelevantMessage` (JSON `{ id }`), `scoreForDM` (JSON `{ score, reason }`), `generateDmReply` (текст).

#### Scenario: JSON-вывод валидируется схемой
- **WHEN** вызывается `selectRelevantMessage` или `scoreForDM`
- **THEN** результат возвращается как валидируемый JSON по схеме `zod` через `completeObject()`

#### Scenario: Невалидный JSON
- **WHEN** structured-вывод невалиден
- **THEN** повтор/ошибка на уровне `generateObject`
