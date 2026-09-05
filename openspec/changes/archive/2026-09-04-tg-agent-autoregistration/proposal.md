## Why

Онбординг агента сейчас — штучная операция (`skills/tg-agent-create`,
`tg-agent-create-v2`), рассчитанная на один аккаунт за раз с ручными шагами
оператора. При масштабировании до десятков аккаунтов, купленных/подготовленных
заранее в виде tdata-сессий Telegram Desktop, штучный процесс не подходит —
нужен один вызов, который превращает пачку архивов в пачку полностью рабочих
агентов платформы.

## What Changes

- Новый детерминированный процесс (OpenClaw-тул → core-модуль, без LLM-цикла)
  `tg-agent-autoregistration`: по параметрам (`megaLinks`, `startAgentNumber`,
  `proxyRegion`, `maxProxyAttempts`, `personName`) обрабатывает пачку
  tdata-архивов последовательно — на каждый аккаунт: подбор мобильного прокси,
  расшифровка tdata-сессии, смена 2FA, сброс прочих сессий, безусловная
  очистка прежних фото/публичных каналов, применение профиля и канала
  выбранной персоны, регистрация второй (агентской) MTProto-сессии, запись
  финальных артефактов агента.
- Новый модуль расшифровки tdata-сессии в рабочую GramJS-сессию
  (`src/core/tdata/`) на основе npm-пакета `@mtcute/convert` — новая
  зависимость проекта.
- Новый набор методов работы с аккаунтом через GramJS (смена 2FA-пароля,
  сброс сессий, обновление профиля/username/даты рождения/фото, создание
  публичного канала с постом, закрепление канала в профиле, удаление
  унаследованных фото/каналов) — этой логики сейчас нет нигде в проекте.
- Новый стейджинг-механизм вне `workspace-<agentId>` для аккаунтов в процессе
  регистрации (`~/.openclaw/tg-agent-autoregistration/staging/`), с
  per-аккаунт статусом (`done`/`proxy_failed`/`setup_failed`/
  `needs_manual_code`) и атомарным переносом в `workspace-agent<N>` только на
  `done` — чтобы недорегистрированный агент не попадал под платформенные
  cron-скрипты, опирающиеся на `listAgentIds()`.
- Новые шаблоны персоны на ВПС (`~/.openclaw/tg-agent-autoregistration/templates/<personName>/`)
  — контент профиля/канала, общие для персоны apiId/apiHash, `SOUL.md`.

## Capabilities

### New Capabilities
- `tg-agent-autoregistration`: массовая автоматическая регистрация Telegram-агентов
  платформы из готовых tdata-сессий — от скачивания архивов из Mega до
  готового `workspace-agent<N>` с рабочей агентской сессией.

### Modified Capabilities
(нет — существующие возможности платформы не меняются)

## Impact

- Новая npm-зависимость: `@mtcute/convert` (+ неявно `@mtcute/node` в рантайме).
- Новые файлы: `src/core/tg-agent-autoregistration/run.ts`,
  `src/core/tdata/*.ts`, `src/scripts/tg-agent-autoregistration.ts`, новый
  OpenClaw-тул в корневом `index.ts`, `skills/tg-agent-autoregistration/SKILL.md`.
- `src/scripts/provision-proxy-for-new-agent.ts` переиспользуется как есть
  (вызывается подпроцессом) — не изменяется.
- `src/core/telegram/service.ts`, `dispatcher.ts` и остальные скиллы платформы
  не меняются.
- Новая директория на ВПС: `~/.openclaw/tg-agent-autoregistration/`
  (`templates/`, `staging/`). Деплой/systemd не меняются.
