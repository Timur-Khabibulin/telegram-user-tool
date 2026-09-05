# Конфигурация и секреты

Какие внешние сервисы и настройки требуются проекту и где лежат их значения.
Значения секретов в этом документе не приводятся.

## Внешние сервисы

| Сервис | Назначение | Источник доступа |
|---|---|---|
| Telegram (MTProto) | основной канал работы агента | `tg-account.json` агента |
| LLM (codex OAuth) | генерация текста и структурированного JSON | `~/.openclaw/codex-auth/auth.json` |
| LLM (OpenAI) | запасная модель (в коде отключена) | `OPENAI_API_KEY` |
| TGStat API | поиск каналов для channel-discovery | env `TGSTAT_TOKEN` (сейчас заглушка) |
| asocks.com | подбор/провижининг мобильных прокси для новых и сломанных агентов | env `ASOCKS_API_KEY` |
| Telegram Bot API (ревью-бот) | ручное подтверждение комментария перед отправкой (post-comment-review) | env `TELEGRAM_REVIEW_BOT_TOKEN`, `TELEGRAM_REVIEW_CHAT_ID` |

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
| `default_agent_data.json` | `apiId`/`apiHash`/`deviceModel`/`2fa`, общие на персону — используется один раз при регистрации |
| `profile_data.json` | `name`/`nick`/`birthdate`/`bio`/`channelName` — используется один раз при регистрации |

Заполняется оператором вручную до регистрации агента — код каталог персоны не создаёт
(кроме `tg-agent-create`, Шаг 7, при явном запросе новой персоны — там создаётся только
`SOUL.md`, остальные файлы шаблона для интерактивной регистрации не нужны).

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

## LLM-доступ — `~/.openclaw/codex-auth/`

| Файл | Назначение |
|---|---|
| `auth.json` | OAuth-токен codex, общий на всех агентов |
| `.env` | `OPENAI_API_KEY` для запасной модели (опционально) |

Путь к `auth.json` задан в `src/llm/client.ts` (`codexAuthFilePath`), параметр
`ensureFresh: true` — токен обновляется автоматически. Основная модель —
`gpt-5.4-mini` через codex-провайдер. Запасная модель (OpenAI) в `client.ts`
закомментирована; пока она отключена, `.env` и `OPENAI_API_KEY` не требуются.

## Секреты внешних сервисов — `~/.openclaw/secrets.env`

Ключи внешних (не-LLM) сервисов, читаемые скриптами напрямую из `process.env`
(без dotenv-загрузки в коде — переменные должны быть в окружении процесса до
старта).

| Переменная | Назначение | Читается в |
|---|---|---|
| `ASOCKS_API_KEY` | доступ к asocks.com для подбора/провижининга мобильных прокси | `src/scripts/provision-proxy-for-new-agent.ts`, `src/scripts/provision-mobile-proxy.ts` |
| `TELEGRAM_REVIEW_BOT_TOKEN` | токен общего Bot API-бота ручного ревью (post-comment-review) — один на платформу, не per-agent | `src/core/review-bot-api.ts` (через `src/core/config.ts`) |
| `TELEGRAM_REVIEW_CHAT_ID` | id чата ревьюеров, куда бот шлёт запросы на подтверждение | `src/core/review-bot-api.ts` (через `src/core/config.ts`) |

Файл подключён как `EnvironmentFile=-/root/.openclaw/secrets.env` в плановых
systemd-юнитах (`deploy/systemd/tg-agent@.service`, `tg-daily-summary.service`,
`tg-funnel-tracker.service`, `tg-channel-activity-update.service`,
`tg-review-listener.service`) — источник правды для них в репозитории, деплой
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
| `REPORT_AGENT_ID` | получатель отчётов (funnel-report, daily-summary) и администратор приватного канала (подсчёт заявок, создание инвайт-ссылок); исключён из `listAgentIds()`, не запускается диспетчером и не ставится в расписание |
| `FUNNEL_PRIVATE_CHANNEL_ID` | ID приватного канала для подсчёта заявок на вступление |

## TGStat — `TGSTAT_TOKEN`

Токен TGStat API для channel-discovery. Ядро токен в env не читает — он приходит
параметром (`runDiscovery(..., tgstatToken)`); источник зависит от точки входа:

- **Скилл `tg_discovery_run`** (в процессе gateway) — токен скоупится на плагин:
  `index.ts` берёт его из `api.pluginConfig.tgstatToken`, то есть из
  `openclaw.json` → `plugins.entries.telegram-user-tool.config.tgstatToken`.
  Это изолирует секрет в конфиге плагина, не в глобальном env OpenClaw. Fallback —
  env `TGSTAT_TOKEN` (для совместимости). После правки конфига — `systemctl restart openclaw`.
- **Скрипт `src/scripts/discovery.ts`** (вне gateway) — из env `TGSTAT_TOKEN`
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
