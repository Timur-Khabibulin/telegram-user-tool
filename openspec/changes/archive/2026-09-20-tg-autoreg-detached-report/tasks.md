# Tasks — tg-autoreg-detached-report

## 1. Доставка отчёта в Saved Messages REPORT_AGENT_ID
- [x] 1.1 `src/scripts/ops/tg-agent-autoregistration.ts`: после `runAutoregistration`
      отправить `renderReport(report)` в Saved Messages `REPORT_AGENT_ID`
      (`TelegramService.loadAccount(REPORT_AGENT_ID)` → `sendSavedMessage` →
      `finally disconnect()`), по образцу `src/scripts/periodic/daily-summary.ts`.
- [x] 1.2 `console.log` отчёта сохранить; сбой доставки в Telegram обернуть в
      try/catch и логировать — не терять уже готовый результат прогона.

## 2. Detached-запуск через скилл
- [x] 2.1 `skills/tg-agent-autoregistration/SKILL.md` Шаг 2: вместо вызова тула
      `tg_agent_autoregistration_run` — запуск ops-скрипта отсоединённо через
      `systemd-run` (транзиентный oneshot-юнит) в cwd
      `~/openclaw-plugins/telegram-user-tool`, с теми же параметрами
      (`--links / --two-fa-password / --start-agent-number / --proxy-region /
      --max-proxy-attempts / --person-name [--create-public-channel false]`).
- [x] 2.2 Шаг 3: заменить «вывести статус по каждому аккаунту» на подтверждение
      «прогон запущен в фоне; итоговый отчёт придёт в Saved Messages получателя
      отчётов (REPORT_AGENT_ID)».
- [x] 2.3 Обновить таблицу «Инструменты» скилла (ops-скрипт вместо тула).

## 3. Доки
- [x] 3.1 `docs/operation.md`: отметить, что отчёт автрегистрации уходит в Saved
      Messages `REPORT_AGENT_ID` (как daily-summary / funnel) — один факт, один дом.

## 4. Проверка
- [x] 4.0 Typecheck изменённого `ops/tg-agent-autoregistration.ts` — без новых ошибок
      (проверено временным tsconfig; 0 ошибок в файле, 9 предсуществующих в
      `service.ts`/`client.ts`/`agent-restrictions.ts` — не трогались).
