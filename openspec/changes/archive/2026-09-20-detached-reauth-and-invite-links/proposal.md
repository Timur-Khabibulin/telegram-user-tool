## Why

`tg_agent_reauth_from_tdata` и `tg_private_invite_links` — синхронные plugin-тулы,
исполняются внутри хода LLM-агента, а у runtime агента (codex app-server) есть
watchdog на один вызов тула ~90 s. Обе операции пробивают этот бюджет: у reauth —
шаг ожидания кода авторизации (`code_timeout`), у invite-links — batch по N агентов
(подключение к сессии каждого через прокси + правка поста). Watchdog убивает вызов
на середине, брошенные GramJS-клиенты сыпят `TIMEOUT` в логи, результат теряется —
та же принципиальная проблема, что уже решена для `tg-agent-autoregistration`
(change `tg-autoreg-detached-report`).

## What Changes

- **reauth-from-tdata → detached.** Оператор задаёт `agentId` и 2FA-пароль сразу в
  начале; прогон исполняется отсоединённым фоновым процессом (`systemd-run` поверх
  нового ops-скрипта), не ограниченным watchdog'ом. Любой исход (успех или отказ:
  `agent_not_found` / `tdata_missing` / `connect_failed` / `code_timeout` /
  `password_rejected` / `error`) — терминальный статус в отчёте; интерактивного
  «СТОП-и-спроси» внутри прогона больше нет. Шаг `openclaw gateway restart` убирается.
- **private-invite-links → detached.** Тул исполняется отсоединённо тем же способом.
  Три режима (обычный / `retryPendingOnly` / `verifyOnly`) сохраняют поведение.
- **Отчёт — асинхронно в Saved Messages `REPORT_AGENT_ID`** (тот же адресат, что у
  daily-summary, funnel и автpрега) — для обоих, вместо синхронного возврата
  вызывающему.
- **Завершение процесса при любом исходе.** Оба ops-скрипта после доставки отчёта
  (в т. ч. при исключении внутри прогона) делают принудительный `process.exit` —
  висящие после таймаута прокси GramJS-клиенты иначе держат event loop навсегда
  (в detached убивать watchdog'ом некому).
- **Plugin-тулы остаются** для точечных/ретрай-кейсов — скиллы просто больше не
  используют их для основного прогона (как оставлен `tg_agent_autoregistration_run`).

## Capabilities

### New Capabilities
<!-- нет новых способностей — меняется модель исполнения и доставки у двух существующих -->

### Modified Capabilities
- `tg-agent-reauth-from-tdata`: исход reauth доставляется в Saved Messages
  `REPORT_AGENT_ID`, а не возвращается синхронно; прогон исполняется отсоединённо
  (не ограничен per-tool-call watchdog'ом) и завершает процесс при любом исходе.
- `private-invite-links`: отчёт прогона доставляется в Saved Messages
  `REPORT_AGENT_ID`, а не возвращается синхронно; прогон исполняется отсоединённо и
  завершает процесс при любом исходе.

## Impact

- Код (новое):
  - `src/scripts/ops/tg-agent-reauth-from-tdata.ts` — тонкий ops-скрипт над
    существующей `reauthFromTdata()`, доставка исхода в Saved Messages, `process.exit`.
  - `src/features/private-invite-links/run.ts` — извлечение логики тула из `index.ts`
    (строки ~1310–1465, три режима) в `runPrivateInviteLinks(params, log)`.
  - `src/scripts/ops/private-invite-links.ts` — тонкий ops-скрипт над новой функцией,
    доставка отчёта в Saved Messages, `process.exit`.
- Код (правка): `index.ts` — тул `tg_private_invite_links` становится тонкой обёрткой
  над `runPrivateInviteLinks()` (поведение не меняется).
- Скиллы: `skills/tg-agent-reauth-from-tdata/SKILL.md`, `skills/private-invite-links/SKILL.md`
  — Шаг запуска через `systemd-run` detached; отчёт придёт в Saved Messages.
- Доки: `docs/operation.md` — отметить, что отчёты reauth и invite-links уходят в
  Saved Messages `REPORT_AGENT_ID` (как daily-summary / funnel / автpрег).
- Прецедент и образец: change `tg-autoreg-detached-report`,
  `src/scripts/ops/tg-agent-autoregistration.ts`.
