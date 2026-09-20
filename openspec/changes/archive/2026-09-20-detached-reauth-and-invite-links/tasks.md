# Tasks — detached-reauth-and-invite-links

## 1. reauth-from-tdata → detached (логика уже вынесена)

- [x] 1.1 `src/scripts/ops/tg-agent-reauth-from-tdata.ts`: тонкий ops-скрипт по
      образцу `ops/tg-agent-autoregistration.ts` — parse argv (`--agent-id`,
      опц. `--password2fa`), вызвать `reauthFromTdata(agentId, password2fa, log)`,
      `console.log` рендер исхода.
- [x] 1.2 В том же скрипте: доставить рендер `ReauthFromTdataOutcome` в Saved
      Messages `REPORT_AGENT_ID` (`TelegramService.loadAccount(REPORT_AGENT_ID)` →
      `sendSavedMessage` → `finally disconnect()`), сбой доставки в try/catch с
      логом — не терять результат прогона.
- [x] 1.3 В том же скрипте: обернуть прогон в try/catch так, чтобы при исключении
      отчёт с текстом ошибки всё равно ушёл в Saved Messages; `process.exit(0)`
      последним шагом (`main().then(()=>exit(0)).catch(...exit(1))`) — из-за
      висящих GramJS-клиентов.
- [x] 1.4 `skills/tg-agent-reauth-from-tdata/SKILL.md`: Шаг 1 — оператор задаёт
      `agentId` и 2FA-пароль сразу; Шаг 2 — запуск ops-скрипта через `systemd-run`
      (транзиентный oneshot, cwd плагина, `EnvironmentFile`), а не вызов тула;
      Шаг 3 — «прогон запущен в фоне, отчёт придёт в Saved Messages
      `REPORT_AGENT_ID`».
- [x] 1.5 `skills/tg-agent-reauth-from-tdata/SKILL.md`: убрать STOP-и-спроси по
      исходам и шаг `openclaw gateway restart`; обновить таблицу «Инструменты»
      (ops-скрипт вместо тула).

## 2. private-invite-links → извлечь run.ts

- [x] 2.1 `src/features/private-invite-links/run.ts`: перенести логику тула из
      `index.ts` (~1310–1465) в `runPrivateInviteLinks(params, tg, log)` с сохранением
      трёх режимов (обычный / `retryPendingOnly` / `verifyOnly`), структуры
      результата и текущего текста отчёта (`renderText`).
- [x] 2.2 `index.ts`: тул `tg_private_invite_links` становится тонкой обёрткой над
      `runPrivateInviteLinks()` — поведение и сигнатура параметров без изменений.

## 3. private-invite-links → detached

- [x] 3.1 `src/scripts/ops/private-invite-links.ts`: тонкий ops-скрипт — parse argv
      (`--agent-ids a,b,c`, `--retry-pending-only`, `--verify-only`; взаимоисключение
      retry/verify), вызвать `runPrivateInviteLinks`, `console.log` отчёт.
- [x] 3.2 В том же скрипте: доставка отчёта в Saved Messages `REPORT_AGENT_ID` при
      любом исходе (включая исключение), `process.exit(0)` последним шагом — как в 1.2/1.3.
- [x] 3.3 `skills/private-invite-links/SKILL.md`: запуск ops-скрипта через
      `systemd-run` detached (три режима — соответствующими флагами) вместо вызова
      тула; сообщить, что отчёт придёт в Saved Messages `REPORT_AGENT_ID`; обновить
      таблицу «Инструменты».

## 4. Доки

- [x] 4.1 `docs/operation.md`: отметить, что отчёты reauth-from-tdata и
      private-invite-links уходят в Saved Messages `REPORT_AGENT_ID` (как
      daily-summary / funnel / автpрег) — один факт, один дом.

## 5. Проверка

- [x] 5.1 Typecheck изменённых файлов (`index.ts`, оба `ops/*.ts`, новый
      `features/private-invite-links/run.ts`) — без новых ошибок (0 ошибок в моих
      файлах; 45 предсуществующих в проекте — better-sqlite3 типы, bigint/EntityLike,
      ChannelIdentity, discovery-экспорты — не трогались).
