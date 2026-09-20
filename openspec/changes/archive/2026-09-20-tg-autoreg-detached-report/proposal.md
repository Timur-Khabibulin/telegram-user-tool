## Why

Массовая автрегистрация — детерминированный batch без диалога: один прогон
обрабатывает пачку аккаунтов последовательно (подбор прокси + 2FA + профиль +
канал + вторая сессия на каждый), это занимает минуты. Сейчас скилл вызывает её
синхронным plugin-тулом `tg_agent_autoregistration_run` внутри хода
LLM-агента. У runtime агента (codex app-server) есть watchdog на один вызов
тула — **90 s**. Прогон в него не влезает: в последнем прогоне (2026-09-16)
watchdog убил тул на 24-й секунде первого `authSignIn` (бюджет шага — 180 s), ни
один аккаунт не дошёл до статуса, а брошенный auth-клиент ещё минуты сыпал
`Not connected`/`TIMEOUT` в логи. То есть текущая схема принципиально не может
завершить пачку.

Плюс отчёт сейчас возвращается синхронно в тот же вызов тула — что и завязывает
его на watchdog, и требует, чтобы оператор ждал весь прогон в чате.

## What Changes

- **Запуск detached.** Batch-прогон выполняется отсоединённым фоновым процессом
  (транзиентный `systemd-run`-юнит поверх ops-скрипта
  `src/scripts/ops/tg-agent-autoregistration.ts`), а не синхронным вызовом
  plugin-тула внутри хода агента. Длительность прогона больше не ограничена
  per-tool-call watchdog'ом runtime агента. Скилл лишь запускает job и сразу
  подтверждает оператору, что прогон стартовал.
- **Отчёт — асинхронно в Saved Messages получателя отчётов.** По завершении
  прогон доставляет итоговый отчёт (per-account `done` / `proxy_failed` /
  `setup_failed` / `needs_manual_code`) в Saved Messages агента `REPORT_AGENT_ID`
  через `TelegramService.sendSavedMessage` — **тот же адресат, что у ежедневной
  сводки** (`daily-summary`) и funnel-отчёта. Фиксированный один получатель:
  ошибиться адресатом (как при попытке отвечать «тому, кто вызвал») невозможно.
- **Plugin-тул `tg_agent_autoregistration_run` остаётся** для точечных/ретрай-
  кейсов — скилл просто больше не использует его для пачки.

## Impact

- Спека `tg-agent-autoregistration`:
  - MODIFIED «Batch summary report» — отчёт доставляется в Saved Messages
    `REPORT_AGENT_ID`, а не возвращается синхронно вызывающему.
  - ADDED «Detached execution not bound by the agent tool-call watchdog» —
    прогон исполняется отсоединённо, дольше per-tool-call таймаута.
- Код: `src/scripts/ops/tg-agent-autoregistration.ts` — доставка `renderReport`
  в Saved Messages `REPORT_AGENT_ID` (по образцу `src/scripts/periodic/daily-summary.ts`).
- Скилл: `skills/tg-agent-autoregistration/SKILL.md` — Шаг 2 запускает ops-скрипт
  через `systemd-run` detached (вместо тула), Шаг 3 сообщает «запущено; отчёт
  придёт в Saved Messages получателя отчётов».
- Доки: `docs/operation.md` — по правилу «один факт — один дом» отметить, что
  отчёт автрегистрации уходит в Saved Messages `REPORT_AGENT_ID` (как
  daily-summary / funnel).

## Заметки

- **Секрет `twoFaPassword` в CLI.** Пароль пачки и сейчас передаётся аргументом
  ops-скрипта (design D4) и параметром тула; через `systemd-run` он попадёт в
  свойства транзиентного юнита и journal. Это не новый риск относительно текущего
  ops-скрипта, но помечено явно.
- **Порядок архивации.** Дельта модифицирует только требование «Batch summary
  report», которого не касаются незаархивированные changes
  `tg-autoreg-gdrive-2fa-input` и `tg-autoreg-optional-channel-and-setup-skill`
  (те меняют Pre-flight / Account setup). Конфликта нет, порядок архивации
  относительно них не важен.
