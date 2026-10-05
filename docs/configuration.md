# Конфигурация и секреты

Какие внешние сервисы и настройки требуются проекту и где лежат их значения.
Значения секретов в этом документе не приводятся.

## Внешние сервисы

| Сервис | Назначение | Источник доступа |
|---|---|---|
| Telegram (MTProto) | основной канал работы агента | `tg-account.json` агента |
| LLM primary (codex-подписка) | генерация текста и структурированного JSON | `~/.openclaw/codex-auth/auth.json` (OAuth-токен ChatGPT) |
| LLM fallback (DeepSeek) | резерв при любой ошибке primary | env `DEEPSEEK_API_KEY` |
| TGStat API | поиск каналов для channel-discovery | env `TGSTAT_TOKEN` (сейчас заглушка) |
| asocks.com | подбор/провижининг мобильных прокси для новых и сломанных агентов | env `ASOCKS_API_KEY` |
| Telegram Bot API (ревью-бот) | ручное подтверждение комментария перед отправкой (post-comment-review) | env `TELEGRAM_REVIEW_BOT_TOKEN`, `TELEGRAM_REVIEW_CHAT_ID` |
| Telegram Bot API (бот распределения) | распределение каналов по агентам через бот (channel-distribution) | env `CHANNEL_DISTRIBUTION_BOT_TOKEN`, `CHANNEL_DISTRIBUTION_CHAT_ID` |

## Учётные данные аккаунта — `tg-account.json`

Расположение: `~/.openclaw/workspace-<agentId>/tg-account.json`. Читается и
валидируется в `src/core/config.ts` (`loadAccountConfig`).

| Поле | Обязательное | Назначение |
|---|---|---|
| `apiId` | да | Telegram API ID |
| `apiHash` | да | Telegram API hash |
| `sessionString` | да | строка сессии GramJS |
| `persona` | да | имя папки шаблона персоны в `~/.openclaw/personas/<persona>/` — см. ниже |
| `device` | нет | `deviceModel`, `systemVersion`, `appVersion`, `langCode`, `systemLangCode` |
| `proxy` | нет | `type` (`socks5`/`socks4`), `host`, `port`, `username`, `password`, `name` (имя порта на стороне провайдера — mobile-proxy-provisioning), `countryCode`/`state`/`city` (локация — сохраняется при подборе, чтобы повторный ремонт прокси не спрашивал регион заново) |
| `reviewGateEnabled` | нет | `true` — `monitor-v3` ставит комментарий на ручное подтверждение перед отправкой вместо немедленной отправки (post-comment-review). По умолчанию выключен (поведение не меняется) |

## Персона — `~/.openclaw/personas/<personName>/`

Общий каталог шаблонов персон — не привязан к конкретной фиче создания агента,
от него зависит рантайм каждого агента, ссылающегося на персону через поле `persona`
в своём `tg-account.json` (см. выше). `SOUL.md` читается диспетчером заново на каждый
прогон (`personaSoulPath` в `src/core/config.ts`) — не копируется в workspace агента.
Имя папки — идентификатор персоны, отдельного поля `id` внутри нет.

| Файл | Назначение |
|---|---|
| `SOUL.md` | текст промпта персоны — читается заново на каждый прогон диспетчера |
| `post.txt` | текст первого поста личного канала — используется один раз при регистрации |
| `photo_profile_1.*..N.*` | фото профиля (расширение любое) — используются один раз при регистрации |
| `channel_photo.*` | фото личного канала — используется один раз при регистрации |
| `channel_post_photo.*` | фото к первому посту — используется один раз при регистрации |
| `profile_data.json` | `name`/`nick`/`birthdate`/`bio`/`channelName` — используется один раз при регистрации |

`apiId`/`apiHash`/`2fa` в шаблоне персоны больше НЕ хранятся — они вынесены в общую
заготовку (см. ниже, tg-agent-pool-provisioning), одинаковую для всех персон.

Заполняется оператором вручную до регистрации агента — код каталог персоны не создаёт
(кроме `tg-agent-create`, Шаг 7, при явном запросе новой персоны — там создаётся только
`SOUL.md`, остальные файлы шаблона для интерактивной регистрации не нужны).

## Общая заготовка учётных данных — `~/.openclaw/account-defaults/`

Общие для ВСЕХ аккаунтов технические значения, вынесенные из персоны
(tg-agent-pool-provisioning). Читаются только фазой 1 (продюсер пула,
`loadAccountDefaults` в `src/core/config.ts`); потребителям пула не нужны — `apiId`/
`apiHash` уже лежат в `tg-account.json` пул-аккаунта.

| Файл | Назначение |
|---|---|
| `default_agent_data.json` | `apiId`/`apiHash`/`2fa`, общие на все аккаунты — используются при подготовке пул-аккаунта |

## tg-agent-autoregistration — `~/.openclaw/tg-agent-autoregistration/`

Массовая регистрация агентов из tdata-сессий (`docs/design/tg-agent-autoregistration/`).
Расшифровка tdata — библиотека `@mtcute/convert` (npm-зависимость, не внешний
сервис — работает локально, без сетевого доступа к mtcute). Скачивание архивов
из Mega — библиотека `megajs`: публичные share-ссылки на папку
(`mega.nz/folder/<id>#<key>`, ключ дешифровки в фрагменте URL), аккаунт Mega
не требуется.

| Путь | Назначение |
|---|---|
| `staging/agent<N>/` | данные аккаунта до статуса `done`: `tdata/`, `status.json`. Не путать с `workspace-agent<N>/` — сюда `listAgentIds()` не заглядывает, недорегистрированный агент не виден платформенным cron-скриптам. |

## LLM-доступ — пул codex-подписок с failover + DeepSeek-floor

Собирается в `src/llm/client.ts` (`createLlmClient`); цепочку провайдеров и
переключение ведёт `src/llm/failover.ts` (`withFailover`), классификацию ошибок —
`src/llm/error-class.ts`, cooldown — `src/core/db/codex-cooldown.ts`
(llm-multi-account-failover).

- **Пул codex-слотов** — несколько ChatGPT-подписок, каждая своим OAuth-токеном в
  `~/.openclaw/codex-auth/<slot>/auth.json`. Модель `gpt-6-luna`, доступ через
  `@openai-oauth/ai-sdk` (корректный codex-`originator`, $0 за токены на подписке).
  Порядок и состав слотов — env `CODEX_ACCOUNTS` (список имён слева направо =
  приоритет); при пустом env — автодискавери подкаталогов `codex-auth/`; легаси
  `codex-auth/auth.json` (без подкаталогов) = единственный слот `default` (обратная
  совместимость с конфигурацией одного аккаунта). Рефреш access-token делает библиотека.
- **Failover по приоритету** — первый доступный слот → следующий → … → DeepSeek
  последним. Переход к следующему слоту с повтором — ТОЛЬКО при исчерпании лимита
  (`usage_limit`); при `401` — рефреш токена и один повтор на том же слоте; прочие
  классы (`schema_error`/`transient`/`auth_403`/`runtime_error`/`other`) — запись в лог
  без повтора и фолбэка.
- **Cooldown по остатку лимита** — при `usage_limit` слот выводится из оборота до
  момента сброса (`reset_at` из `GET /backend-api/wham/usage`, без траты квоты
  генерации), запись — в host-level `~/.openclaw/codex-cooldown.db` (общий на хост).
  Доступность слота проверяется по сохранённой дате, не пробным запросом. Если
  `/wham/usage` недоступен — консервативное окно `CODEX_COOLDOWN_FALLBACK_SECONDS`
  (по умолчанию 5 ч).
- **DeepSeek-floor** — `deepseek-flash` (`@ai-sdk/deepseek`), ключ `DEEPSEEK_API_KEY`
  из `~/.openclaw/secrets.env`, последним звеном цепочки. Ключ обязателен — при его
  отсутствии `createLlmClient` бросает ошибку конфигурации. Предохранитель работает
  только при ненулевом балансе DeepSeek (операционная зависимость).
- **Изоляция по рабочему элементу** — при неуспехе LLM по одному элементу (канал/тред/
  пост/DM) бросается типизированная `LlmCallError`; скилл ловит её per-item и пропускает
  элемент, прогон продолжается (не падает целиком). Переключения и cooldown логируются
  в journald строками `[llm] …`.

## Секреты внешних сервисов — `~/.openclaw/secrets.env`

Ключи внешних сервисов, читаемые скриптами напрямую из `process.env` (без
dotenv-загрузки в коде — переменные должны быть в окружении процесса до старта).

| Переменная | Назначение | Читается в |
|---|---|---|
| `DEEPSEEK_API_KEY` | доступ к DeepSeek (`deepseek-flash`) — **floor** LLM, последнее звено цепочки failover (обязателен) | `src/llm/client.ts` (`createLlmClient`) |
| `CODEX_ACCOUNTS` | список имён codex-слотов через запятую (приоритет слева направо); пусто → автодискавери подкаталогов `~/.openclaw/codex-auth/`, легаси `auth.json`=`default` | `src/core/config.ts` |
| `CODEX_COOLDOWN_FALLBACK_SECONDS` | окно cooldown слота (сек), если `/wham/usage` недоступен; по умолчанию 18000 (5 ч) | `src/core/config.ts` |
| `ASOCKS_API_KEY` | доступ к asocks.com для подбора/провижининга мобильных прокси | `src/scripts/ops/provision-proxy-for-new-agent.ts`, `src/scripts/ops/provision-mobile-proxy.ts` |
| `TELEGRAM_REVIEW_BOT_TOKEN` | токен общего Bot API-бота ручного ревью (post-comment-review) — один на платформу, не per-agent | `src/core/review-bot-api.ts` (через `src/core/config.ts`) |
| `TELEGRAM_REVIEW_CHAT_ID` | id чата ревьюеров, куда бот шлёт запросы на подтверждение | `src/core/review-bot-api.ts` (через `src/core/config.ts`) |
| `CHANNEL_DISTRIBUTION_BOT_TOKEN` | токен отдельного Bot API-бота распределения каналов (channel-distribution) — один на платформу, отдельный от ревью-бота (лимит один `getUpdates` на токен) | `src/core/distribution-bot-api.ts` (через `src/core/config.ts`) |
| `CHANNEL_DISTRIBUTION_CHAT_ID` | id уполномоченного чата, из которого бот принимает команды и CSV (авторизация по чату, default-deny) | `src/core/distribution-bot-api.ts` (через `src/core/config.ts`) |
| `GOOGLE_SHEETS_KEY_PATH` | путь к JSON-ключу сервис-аккаунта Google для конвейера метрик (channel-metrics-pipeline); таблица расшарена на его email как Редактор | `src/core/google-sheets.ts` (через `src/core/config.ts`) |
| `CHANNELS_SHEET_ID` | ID Google-таблицы с листом анализированных каналов (дедуп входа и запись результата) | `src/core/google-sheets.ts` (через `src/core/config.ts`) |
| `CHANNELS_SHEET_NAME` | имя целевого листа; по умолчанию `all-processed-channels`, задавать только если лист переименован | `src/core/google-sheets.ts` (через `src/core/config.ts`) |

Файл подключён как `EnvironmentFile=-/root/.openclaw/secrets.env` в плановых
systemd-юнитах (`deploy/systemd/tg-agent@.service`, `tg-daily-summary.service`,
`tg-funnel-tracker.service`, `tg-channel-activity-update.service`,
`tg-review-listener.service`, `tg-distribution-listener.service`) — источник правды для них в репозитории, деплой
на VPS через skill `vps` + `systemctl daemon-reload`.

Интерактивные скиллы (например, `tg-agent-create-v2`) выполняются как дочерний
процесс gateway, а не через эти юниты. Gateway на сервере запущен через
user-unit `root`-а — `~/.config/systemd/user/openclaw-gateway.service` (это
юнит самого OpenClaw, не часть этого репозитория, правится только на VPS
вручную) — туда тоже нужно добавить `EnvironmentFile=-/root/.openclaw/secrets.env`
и выполнить `systemctl --user daemon-reload && systemctl --user restart openclaw-gateway`,
иначе скиллы, которым нужны эти ключи, их не увидят.

## Константы в коде — `src/core/config.ts`

| Константа | Назначение |
|---|---|
| `FUNNEL_ADMIN_AGENT_ID` | владелец `funnel.db`/`discovery.db`/`reports/`/`private-invites.db` |
| `REPORT_AGENT_ID` | получатель отчётов (funnel-report, daily-summary) и единый администратор всех приватных каналов персон (подсчёт заявок, создание инвайт-ссылок); исключён из `listAgentIds()`, не запускается диспетчером и не ставится в расписание |

ID приватного канала воронки задаётся **per-persona** в шаблоне персоны
`~/.openclaw/personas/<persona>/profile_data.json` полем `funnelPrivateChannelId`
(marked peer id, вид `-100…`), а не константой в коде (per-persona-funnel-channel).
Персона без этого поля не участвует в подсчёте заявок. `REPORT_AGENT_ID` должен быть
админом (право `invite_users`) каждого такого канала.

## TGStat — `TGSTAT_TOKEN`

Токен TGStat API для channel-discovery. Ядро токен в env не читает — он приходит
параметром (`runDiscovery(..., tgstatToken)`); источник зависит от точки входа:

- **Скилл `tg_discovery_run`** (в процессе gateway) — токен скоупится на плагин:
  `index.ts` берёт его из `api.pluginConfig.tgstatToken`, то есть из
  `openclaw.json` → `plugins.entries.telegram-user-tool.config.tgstatToken`.
  Это изолирует секрет в конфиге плагина, не в глобальном env OpenClaw. Fallback —
  env `TGSTAT_TOKEN` (для совместимости). После правки конфига — `systemctl restart openclaw`.
- **Скрипт `src/scripts/ops/discovery.ts`** (вне gateway) — из env `TGSTAT_TOKEN`
  (`config.ts` → `TGSTAT_API_TOKEN`), инлайн: `TGSTAT_TOKEN=… npx tsx …`. Заглушка
  `STUB_TGSTAT_TOKEN` отклоняется на старте.

Параметры поиска (по API TGStat, проверено запросами): `DISCOVERY_COUNTRY` = `ru`
(НЕ `russia`), `DISCOVERY_LANGUAGE` = `russian` (НЕ `ru`) — константы в `config.ts`.

## Доступ к серверу — `local.properties`

Локальный файл со значениями для синхронизации с сервером.

| Поле | Назначение |
|---|---|
| `vpsIp`, `vpsUser`, `userPassword` | доступ к VPS |
| `configDir` | путь к `openclaw.json` на сервере |
| `vpsPluginDir` | каталог плагина на сервере |
| `vpsSkillsDir` | каталог скиллов на сервере |
| `vpsAgentDir` | шаблон каталога агента |
