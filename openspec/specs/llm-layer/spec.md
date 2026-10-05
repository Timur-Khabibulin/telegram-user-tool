# llm-layer Specification

## Purpose
TBD - created by archiving change task-scheduler. Update Purpose after archive.
## Requirements
### Requirement: codex-подписка как primary через @openai-oauth/ai-sdk

Primary LLM SHALL идти на ChatGPT-подписку через `@openai-oauth/ai-sdk`
(`createOpenAIOAuth(openaiCredentials({ authFilePath }))`), модель `gpt-6-luna`, но не на
один аккаунт, а на **пул codex-слотов** со строгим приоритетом. Цепочка провайдеров на
момент вызова SHALL быть: доступные codex-слоты в порядке приоритета (без тех, что на
cooldown), затем DeepSeek последним звеном. Библиотека шлёт корректный codex-`originator`,
запросы проходят гейтинг codex-бэкенда. Персона передаётся как `system`. Имя модели
фиксировано (`gpt-6-luna`); отказ по версии/`minimal_client_version` классифицируется как
`other` (лог без переключения).

#### Scenario: Primary-вызов на первый доступный слот

- **WHEN** скилл вызывает `complete()`/`completeObject()` и первый по приоритету codex-слот
  не на cooldown
- **THEN** запрос уходит на `gpt-6-luna` этого слота через `@openai-oauth/ai-sdk` на
  подписке (без потокенной оплаты)

#### Scenario: Порядок приоритета, не round-robin

- **WHEN** в пуле несколько codex-слотов
- **THEN** всегда выбирается первый доступный по заданному порядку; чередование по кругу не
  применяется

### Requirement: codex-токен из общего auth.json с авто-рефрешем

Каждый codex-слот SHALL использовать собственный каталог
`~/.openclaw/codex-auth/<slot>/auth.json` (один токен на слот, общий для всех агентов и
прогонов хоста); рефреш access-token выполняет `@openai-oauth/ai-sdk` автоматически.
Порядок и состав слотов задаются списком имён в env `CODEX_ACCOUNTS` (слева направо —
приоритет); при пустом env слоты обнаруживаются автодискавери подкаталогов. Легаси-файл
`~/.openclaw/codex-auth/auth.json` (без подкаталогов) SHALL трактоваться как единственный
слот `default` — обратная совместимость с конфигурацией одного аккаунта. Каталог
`~/.openclaw/codex-auth/` не удаляется.

#### Scenario: Токен слота обновляется автоматически

- **WHEN** access-token в `auth.json` слота протух, а refresh-token валиден
- **THEN** библиотека рефрешит access-token без ручного вмешательства, вызов проходит

#### Scenario: Легаси-файл как единственный слот

- **WHEN** есть `~/.openclaw/codex-auth/auth.json`, но нет подкаталогов-слотов и пустой
  `CODEX_ACCOUNTS`
- **THEN** он используется как слот `default`, поведение «один аккаунт» сохраняется без
  миграции

### Requirement: DeepSeek как fallback на любую ошибку primary

Переключение провайдеров SHALL определяться **классом ошибки** (см. требование
«Классификация ошибок ответа LLM»), а не единым каскадом на любую ошибку. Переход к
следующему провайдеру с повтором SHALL выполняться **только** при классе `usage_limit`
(переход к следующему доступному codex-слоту по приоритету, в конце цепочки — DeepSeek).
DeepSeek (`deepseek-flash`) SHALL быть последним звеном цепочки и использоваться, только
когда все codex-слоты недоступны. Остальные классы ошибок к переходу на DeepSeek не ведут.

#### Scenario: Исчерпание лимита уводит на следующий codex-слот

- **WHEN** текущий codex-слот возвращает `usage_limit`, а в пуле есть доступный следующий
  слот
- **THEN** тот же вызов исполняется следующим codex-слотом по приоритету (не DeepSeek)

#### Scenario: DeepSeek — только когда все codex недоступны

- **WHEN** все codex-слоты на cooldown или исчерпаны в рамках вызова
- **THEN** вызов исполняется DeepSeek; при его успехе результат возвращается штатно

#### Scenario: Не-лимитная ошибка не уводит на DeepSeek

- **WHEN** codex-слот возвращает ошибку класса `schema_error`/`transient`/`auth_403`/
  `runtime_error`/`other`
- **THEN** вызов завершается неуспехом без перехода на следующий провайдер и без фолбэка на
  DeepSeek

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

### Requirement: Классификация ошибок ответа LLM

LLM-слой SHALL классифицировать каждую неуспешную попытку ответа ровно в один класс по
сигнатуре (HTTP-код, тело, значимые поля/заголовки, тип JS-исключения): `usage_limit`,
`schema_error`, `transient`, `auth_401`, `auth_403`, `runtime_error`, `other`. Реакция
SHALL зависеть от класса: `usage_limit` — cooldown слота + переход к следующему провайдеру
и повтор; `auth_401` — рефреш токена слота и один повтор на **том же** провайдере (если
рефреш не удался — лог без повтора); `schema_error`, `transient`, `auth_403`,
`runtime_error`, `other` — запись в лог без повтора и без фолбэка. Cooldown SHALL
ставиться **только** классом `usage_limit`.

#### Scenario: Ошибка схемы не уводит аккаунт из оборота

- **WHEN** codex возвращает `schema_error` (HTTP 400, «Invalid schema for response_format»)
- **THEN** ошибка пишется в лог, cooldown не ставится, переход к следующему провайдеру не
  выполняется, слот остаётся доступным

#### Scenario: 401 — рефреш и повтор на том же провайдере

- **WHEN** codex-слот возвращает `auth_401`
- **THEN** выполняется принудительный рефреш токена слота и один повтор на том же слоте;
  при повторном неуспехе/неудачном рефреше — лог без перехода к другому провайдеру

#### Scenario: Структурный путь не маскирует провайдерную ошибку

- **WHEN** в `completeObject` слой нативного structured output получает ошибку класса не
  `schema_error` (например `usage_limit`)
- **THEN** ошибка пробрасывается наружу в цикл failover, а не поглощается `catch` и не
  уводится в текстовый путь того же слота

### Requirement: Cooldown аккаунта по остатку лимита из эндпоинта остатка

При классе `usage_limit` LLM-слой SHALL определять момент сброса лимита слота из
`GET https://chatgpt.com/backend-api/wham/usage` (поле `reset_at` исчерпанного окна;
`primary` 5ч и/или `secondary` недельного; при нескольких — наиболее поздний момент) и
выводить слот на cooldown до этого момента. Запрос остатка SHALL не расходовать квоту
генерации. Состояние cooldown SHALL храниться в host-level SQLite
`~/.openclaw/codex-cooldown.db` (общее на хост, одна строка на слот, переживает рестарт
процесса). Доступность слота перед вызовом SHALL определяться чтением сохранённой даты, без
пробного запроса к модели. Если эндпоинт остатка недоступен — применяется консервативное
фолбэк-окно cooldown (5 часов).

#### Scenario: Cooldown до точной даты сброса

- **WHEN** слот вернул `usage_limit`
- **THEN** из `/wham/usage` берётся `reset_at`, слот помечается недоступным до этой даты в
  `codex-cooldown.db`, запрос остатка не тратит квоту генерации

#### Scenario: Доступность проверяется по дате

- **WHEN** строится цепочка провайдеров
- **THEN** слот с `cooldown_until > now` пропускается без обращения к модели; слот, у
  которого момент сброса наступил, снова считается доступным

#### Scenario: Эндпоинт остатка недоступен

- **WHEN** при `usage_limit` запрос `/wham/usage` не удался
- **THEN** слот выводится на cooldown на консервативное окно (5 часов) и вызов переходит к
  следующему провайдеру

### Requirement: Изоляция ошибки LLM по рабочему элементу

Неуспех LLM-вызова (любой класс, завершающийся неуспехом) SHALL сигнализироваться наружу
типизированной ошибкой `LlmCallError` (с полем класса), отличимой по типу от сигналов
останова всего прогона (`ClientNotConnectedError`, `PeerFloodError`). Скилл-потребитель
SHALL ловить `LlmCallError` на уровне цикла по рабочим элементам (канал, тред, пост,
DM-кандидат) и трактовать как пропуск элемента (лог → пометить обработанным → продолжить со
следующего), не прерывая весь прогон. Останов всего прогона допустим только по явным
сигналам, не связанным с классификацией LLM-ошибок.

#### Scenario: Ошибка по одному каналу не роняет прогон

- **WHEN** в прогоне `monitor-v5` LLM-вызов по одному каналу завершается `LlmCallError`
- **THEN** ошибка логируется, канал пропускается, прогon продолжает обрабатывать остальные
  каналы; прогон не завершается целиком

#### Scenario: Сигнал останова по-прежнему останавливает

- **WHEN** возникает `PeerFloodError`/`ClientNotConnectedError`
- **THEN** прогон останавливается, как и раньше (эти сигналы не являются `LlmCallError`)

