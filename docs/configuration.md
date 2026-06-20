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

## Учётные данные аккаунта — `tg-account.json`

Расположение: `~/.openclaw/workspace-<agentId>/tg-account.json`. Читается и
валидируется в `src/core/config.ts` (`loadAccountConfig`).

| Поле | Обязательное | Назначение |
|---|---|---|
| `apiId` | да | Telegram API ID |
| `apiHash` | да | Telegram API hash |
| `sessionString` | да | строка сессии GramJS |
| `device` | нет | `deviceModel`, `systemVersion`, `appVersion`, `langCode`, `systemLangCode` |
| `proxy` | нет | `type` (`socks5`/`socks4`), `host`, `port`, `username`, `password` |

## LLM-доступ — `~/.openclaw/codex-auth/`

| Файл | Назначение |
|---|---|
| `auth.json` | OAuth-токен codex, общий на всех агентов |
| `.env` | `OPENAI_API_KEY` для запасной модели (опционально) |

Путь к `auth.json` задан в `src/llm/client.ts` (`codexAuthFilePath`), параметр
`ensureFresh: true` — токен обновляется автоматически. Основная модель —
`gpt-5.4-mini` через codex-провайдер. Запасная модель (OpenAI) в `client.ts`
закомментирована; пока она отключена, `.env` и `OPENAI_API_KEY` не требуются.

## Константы в коде — `src/core/config.ts`

| Константа | Назначение |
|---|---|
| `FUNNEL_ADMIN_AGENT_ID` | агент — получатель отчёта-воронки и владелец `funnel.db` |
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
