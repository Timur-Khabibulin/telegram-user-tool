## ADDED Requirements

### Requirement: DeepSeek как primary через @ai-sdk/deepseek

Вызовы LLM SHALL идти на DeepSeek V4 Flash (модель `deepseek-flash`) через
официальный провайдер `@ai-sdk/deepseek`. Персона передаётся как `system`-сообщение;
codex-специфичный `providerOptions.openai.instructions` НЕ используется.

#### Scenario: Primary-вызов на DeepSeek

- **WHEN** скилл вызывает `complete()` или `completeObject()`
- **THEN** запрос уходит на `deepseek-flash` через `@ai-sdk/deepseek`

### Requirement: Аутентификация статическим API-ключом

Аутентификация SHALL выполняться статическим ключом `DEEPSEEK_API_KEY` из окружения
процесса (загружается из `~/.openclaw/secrets.env` через systemd `EnvironmentFile`),
один ключ на всех агентов (общий пул лимита DeepSeek). Файла OAuth-токена и его
рефреша больше нет.

#### Scenario: Все агенты используют один API-ключ

- **WHEN** несколько агентов вызывают LLM
- **THEN** все используют один `DEEPSEEK_API_KEY` из окружения процесса

#### Scenario: Ключ отсутствует

- **WHEN** `DEEPSEEK_API_KEY` не задан в окружении
- **THEN** вызов LLM завершается ошибкой конфигурации, а не тихим неверным запросом

## MODIFIED Requirements

### Requirement: Единственный provider без failover

`LlmClient` SHALL использовать ровно одну модель DeepSeek (`deepseek-flash`)
напрямую, без обёртки `createFallback` и без второго провайдера. При ошибке или
лимите запрос завершается ошибкой — автоматического переключения на другого
провайдера нет.

#### Scenario: Rate-limit не переключает на другую модель

- **WHEN** DeepSeek возвращает 429 или иную ошибку
- **THEN** запрос завершается ошибкой; повторный успешный вызов возможен только
  после восстановления DeepSeek (второго провайдера в клиенте нет)

## REMOVED Requirements

### Requirement: codex через OAuth как primary

**Reason**: codex-бэкенд (`chatgpt.com/backend-api/codex/responses`) с ~08.09.2026
отвергает все модели для ChatGPT-аккаунта (гейтинг по `originator`); доступ к OpenAI
из РФ условный. Провайдер заменён на DeepSeek.
**Migration**: см. ADDED «DeepSeek как primary через @ai-sdk/deepseek».

### Requirement: Автоматический рефреш токена с write-back

**Reason**: DeepSeek использует статический API-ключ; OAuth-рефреш и write-back в
`auth.json` не нужны.
**Migration**: ключ `DEEPSEEK_API_KEY` в `~/.openclaw/secrets.env`; см. ADDED
«Аутентификация статическим API-ключом».

### Requirement: Общий auth.json на всех агентов

**Reason**: OAuth-токен-файл `~/.openclaw/codex-auth/auth.json` больше не
используется.
**Migration**: единый `DEEPSEEK_API_KEY` в `~/.openclaw/secrets.env` обслуживает всех
агентов; каталог `codex-auth/` отмирает.
