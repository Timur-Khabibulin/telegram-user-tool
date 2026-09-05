## Why

Часть агентов платформы (созданных ещё до появления `tg-agent-autoregistration`) имеет
сессии, отозванные Telegram (`AUTH_KEY_DUPLICATED` / ограничение `need_update_session`) —
на момент написания 26 агентов, число продолжает расти день за днём. Для этих аккаунтов
у оператора есть локальная tdata-сессия (Telegram Desktop) — она уже авторизована, но
единственный существующий способ реавторизации (`skills/tg-agent-reauth`) требует, чтобы
оператор сам получил код из Telegram и ввёл его вручную. Нужен способ реавторизовать
такого агента автоматически, используя уже имеющуюся tdata, без участия оператора в
получении кода.

## What Changes

- Новый OpenClaw-инструмент `tg_agent_reauth_from_tdata(agentId, password2fa?)` —
  реавторизует уже существующего агента: расшифровывает tdata из
  `~/.openclaw/workspace-<agentId>/tdata/`, устанавливает bootstrap-соединение через неё,
  регистрирует новую независимую MTProto-сессию агента (код авторизации перехватывается
  автоматически через это же bootstrap-соединение — оператор его не вводит), перезаписывает
  только поле `sessionString` в существующем `tg-account.json` агента (остальные поля —
  `apiId`, `apiHash`, `device`, `proxy`, `accountId` — не меняются).
- Новый скилл `skills/tg-agent-reauth-from-tdata/SKILL.md` — детерминированный операторский
  флоу без пошагового диалога: указать `agentId` (tdata заранее загружена оператором на
  сервер), вызвать инструмент, сообщить результат; при ошибке неверного 2FA-пароля —
  запросить у оператора актуальный пароль и повторить.
- Новый путь `tdataPath(agentId)` в `src/core/config.ts`, по конвенции существующих
  `channelsDbPath`/`tasksDbPath`.
- Переиспользование без изменений существующих модулей: `src/core/tdata/client.ts`
  (`connectBootstrap`, `readTdataAccountInfo`, `readIncomingCode`),
  `src/core/tg-agent-autoregistration/agentic-session.ts` (`registerAgenticSession`),
  `src/core/telegram/service.ts` (`authSendCode`/`authSignIn`).

## Capabilities

### New Capabilities
- `tg-agent-reauth-from-tdata`: автоматическая реавторизация существующего Telegram-агента
  платформы из локальной tdata-сессии — без участия оператора в получении кода
  авторизации.

### Modified Capabilities
(нет — существующие способности платформы, `tg-agent-autoregistration` и `tg-agent-reauth`,
не меняются; их код только переиспользуется как библиотека)

## Impact

- Новые файлы: `src/core/tg-agent-reauth-from-tdata/run.ts`, новый OpenClaw-тул в
  корневом `index.ts`, `skills/tg-agent-reauth-from-tdata/SKILL.md`.
- `src/core/config.ts` — добавлен один новый path-helper `tdataPath(agentId)`.
- `src/core/tdata/*`, `src/core/tg-agent-autoregistration/agentic-session.ts`,
  `src/core/telegram/service.ts`, `dispatcher.ts` и остальные скиллы платформы —
  не меняются.
- Предполагает, что оператор вручную загружает папку tdata на сервер в
  `~/.openclaw/workspace-<agentId>/tdata/` до вызова инструмента — сам процесс загрузки
  вне скоупа этого change.
- Затрагивает учётные данные аккаунта (создаёт новую MTProto-сессию, использует
  2FA-пароль) — операция необратимая по своей природе (новая сессия не отменяет
  создание), требует явного вызова оператором на конкретном агенте, не выполняется
  массово/автоматически по расписанию.
