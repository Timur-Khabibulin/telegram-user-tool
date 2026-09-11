<!-- Дельта относительно состояния после архивации migrate-llm-to-deepseek
     (DeepSeek — primary). Порядок: сначала архивировать migrate-llm-to-deepseek. -->

## ADDED Requirements

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
Ключ DeepSeek — `DEEPSEEK_API_KEY` из `~/.openclaw/secrets.env`.

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

## REMOVED Requirements

### Requirement: DeepSeek как primary через @ai-sdk/deepseek

**Reason**: DeepSeek становится fallback, а не primary — вернулась доступная и более
дешёвая codex-подписка (через живую `@openai-oauth/ai-sdk`).
**Migration**: см. ADDED «codex-подписка как primary через @openai-oauth/ai-sdk» и
«DeepSeek как fallback на любую ошибку primary».

### Requirement: Единственный provider без failover

**Reason**: возвращается failover (primary codex + fallback DeepSeek) через `ai-fallback`.
**Migration**: см. ADDED «DeepSeek как fallback на любую ошибку primary».
