# Снимок структуры `src/` на ВПС перед деплоем ADR 0007

Дата снятия: 2026-09-05, до деплоя переноса `src/core/` → `core/`+`features/` и
группировки `src/scripts/` на `periodic/`/`ops/`. Источник:
`~/.openclaw/extensions/telegram-user-tool/` на `root@<VPS_HOST>`
(`find src index.ts -type f`). Нужен как точка отката, если после деплоя
что-то пойдёт не так — можно свериться, что было на диске сервера до переноса.

**Обновление 2026-09-05 (после снятия снимка):** 24 файла, перечисленных в
разделе «Расхождение с локальным репозиторием» ниже, перенесены на ВПС в
`src/old/` (с сохранением относительной структуры — `src/old/core/...`,
`src/old/scripts/...`) командой `mv`, одним SSH-подключением. Оригинальные
файлы больше не лежат на прежних путях внутри `src/`; при откате их можно
вернуть оттуда же.

## Расхождение с локальным репозиторием (важно)

На ВПС есть файлы, которых **нет в локальном git-репозитории вообще** — то есть
не просто «старая структура», а незакоммиченный дрейф прод-сервера:

- `src/core/channels.ts` — на верхнем уровне `core/`, не в `core/db/` (в репо
  есть только `core/db/channels.ts`).
- `.bak-*` файлы-бэкапы (ручные снапшоты перед правками прямо на сервере):
  `channel-metrics/run.ts.bak-202608262334`,
  `post-comment-send.ts.bak-20260827023951`,
  `post-comment-send.ts.bak-20260828212100`,
  `telegram/service.ts.bak-before-graceful-1211`,
  `telegram/service.ts.bak-before-lock-202608262234`,
  `telegram/service.ts.bak-before-median-1124`,
  `telegram/service.ts.bak-before-restrict-2213`,
  `telegram/service.ts.bak-deleted-comments-check`,
  `telegram/session-lock.ts.bak-before-graceful-1211`,
  `telegram/session-lock.ts.bak-v3-202608262209`,
  `scripts/channel-activity-update.ts.bak-202608262351`,
  `scripts/channel-activity-update.ts.bak-before-median-1124`,
  `scripts/channel-activity-update.ts.bak-perpost-1145`,
  `scripts/channel-niche.ts.bak-v3-202608262209`,
  `scripts/deleted-comments-check.ts.bak-20260828215515`.
- Разовые/отладочные скрипты в `src/scripts/`, которых нет в репо:
  `_dialog_names.ts`, `_probe2.ts`, `_probe3.ts`, `_resolve_ids.ts`,
  `_reverse.ts`, `_zerohash.ts`, `deleted-comments-check.ts`,
  `tmp-oneoff/enable-leave-banned.ts`.

**Следствие для деплоя ADR 0007:** полная синхронизация `src/` с локальным
репозиторием (`rsync --delete` или аналог) удалит эти файлы с сервера. Прежде
чем деплоить — решить, что с ними делать (перенести в репозиторий, скачать как
архив на всякий случай, или подтвердить, что можно потерять) — это отдельный
вопрос координатору, не решаю сам.

## Полный список файлов на ВПС (на момент снятия)

```
index.ts
src/core/activity-percentile.ts
src/core/channel-analysis/run.ts
src/core/channel-context/run.ts
src/core/channel-metrics/run.ts
src/core/channel-metrics/run.ts.bak-202608262334
src/core/channel-preview/preview.ts
src/core/channel-sync.ts
src/core/channels.ts
src/core/config.ts
src/core/db/agent-restrictions.ts
src/core/db/channels.ts
src/core/db/discovery.ts
src/core/db/dispatcher-runs.ts
src/core/db/dm-history.ts
src/core/db/dm-threads.ts
src/core/db/error-log.ts
src/core/db/funnel.ts
src/core/db/join-queue.ts
src/core/db/llm-log.ts
src/core/db/pending-reviews.ts
src/core/db/private-invites.ts
src/core/db/replies.ts
src/core/db/runs.ts
src/core/db/tasks.ts
src/core/device-pool.ts
src/core/discovery/run.ts
src/core/discovery/similar.ts
src/core/discovery/tgstat.ts
src/core/errors.ts
src/core/freshness-gate.ts
src/core/funnel-collect.ts
src/core/funnel-report.ts
src/core/logger.ts
src/core/post-comment-send.ts
src/core/post-comment-send.ts.bak-20260827023951
src/core/post-comment-send.ts.bak-20260828212100
src/core/proxy/asocks-client.ts
src/core/proxy/proxy-pool.ts
src/core/review-bot-api.ts
src/core/runs-summary.ts
src/core/scheduler-control.ts
src/core/tdata/account-setup.ts
src/core/tdata/client.ts
src/core/tdata/errors.ts
src/core/tdata/index.ts
src/core/telegram/errors.ts
src/core/telegram/gramjs-logger.ts
src/core/telegram/service.ts
src/core/telegram/service.ts.bak-before-graceful-1211
src/core/telegram/service.ts.bak-before-lock-202608262234
src/core/telegram/service.ts.bak-before-median-1124
src/core/telegram/service.ts.bak-before-restrict-2213
src/core/telegram/service.ts.bak-deleted-comments-check
src/core/telegram/session-lock.ts
src/core/telegram/session-lock.ts.bak-before-graceful-1211
src/core/telegram/session-lock.ts.bak-v3-202608262209
src/core/tg-agent-autoregistration/agentic-session.ts
src/core/tg-agent-autoregistration/device-assignment.ts
src/core/tg-agent-autoregistration/id-range.ts
src/core/tg-agent-autoregistration/persona-template.ts
src/core/tg-agent-autoregistration/proxy-selection.ts
src/core/tg-agent-autoregistration/run.ts
src/core/tg-agent-autoregistration/staging.ts
src/core/tg-agent-autoregistration/username.ts
src/core/tg-agent-reauth-from-tdata/run.ts
src/llm/client.ts
src/llm/prompts.ts
src/scripts/_dialog_names.ts
src/scripts/_probe2.ts
src/scripts/_probe3.ts
src/scripts/_resolve_ids.ts
src/scripts/_reverse.ts
src/scripts/_zerohash.ts
src/scripts/activate-leave-banned-for-agents.ts
src/scripts/backfill-agent-usernames.ts
src/scripts/backfill-schedule-defaults.ts
src/scripts/channel-activity-update-manual.sh
src/scripts/channel-activity-update.ts
src/scripts/channel-activity-update.ts.bak-202608262351
src/scripts/channel-activity-update.ts.bak-before-median-1124
src/scripts/channel-activity-update.ts.bak-perpost-1145
src/scripts/channel-metrics.ts
src/scripts/channel-niche.ts
src/scripts/channel-niche.ts.bak-v3-202608262209
src/scripts/daily-summary.ts
src/scripts/deleted-comments-check.ts
src/scripts/deleted-comments-check.ts.bak-20260828215515
src/scripts/diag-proxy-connect.ts
src/scripts/disable-join-queue-all.ts
src/scripts/discovery-add-pool.ts
src/scripts/discovery-backfill.ts
src/scripts/discovery-similar.ts
src/scripts/discovery.ts
src/scripts/dispatcher.ts
src/scripts/distribute-channels.ts
src/scripts/distribute-pool.ts
src/scripts/enable-monitor-v5-for-agents.ts
src/scripts/funnel-tracker.ts
src/scripts/import-agent-pool.ts
src/scripts/join-queue-backfill.ts
src/scripts/leave-all-channels.ts
src/scripts/provision-mobile-proxy.ts
src/scripts/provision-proxy-for-new-agent.ts
src/scripts/redistribute-channels.ts
src/scripts/review-listener.ts
src/scripts/tg-agent-autoregistration-retry-code.ts
src/scripts/tg-agent-autoregistration.ts
src/scripts/tmp-oneoff/enable-leave-banned.ts
src/skills/account-warmup.ts
src/skills/channel-cleanup.ts
src/skills/channel-context.ts
src/skills/dm-replies.ts
src/skills/dm-send.ts
src/skills/join-queue.ts
src/skills/leave-banned-channels.ts
src/skills/monitor-v2.ts
src/skills/monitor-v3.ts
src/skills/monitor-v4.ts
src/skills/monitor-v5.ts
src/skills/monitor-v5.ts.bak-20260828214816
src/skills/monitor.ts
src/skills/types.ts
src/skills/util.ts
```
