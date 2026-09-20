# Доступ к аналитике для внешнего Claude Desktop

## О проекте

Платформа для запуска Telegram-агентов. Агент — это один Telegram-аккаунт со своей
персоной (`SOUL.md`), работающий автономно по расписанию через MTProto: читает
непрочитанные сообщения в группах, отвечает в характере персоны, отбирает и пишет
DM-кандидатам, ведёт личные диалоги, прогревает аккаунт имитацией активности обычного
пользователя, вступает в группы обсуждений по очереди и раз в день собирает метрики
воронки (активность, просмотры, подписчики, заявки в приватный канал). Платформа
управляет несколькими такими агентами одновременно — данные и персона у каждого свои,
один агент назначен админ-агентом и хранит данные уровня всей платформы (воронка,
реестр найденных каналов).

Всё это крутится на одном VPS под systemd. Этот документ — не про сам проект, а про
то, как внешнему человеку читать накопленные агентами данные (БД SQLite) с VPS через
свой Claude Desktop, без участия основной команды.

## Подключение

- `ssh -i ~/.ssh/vps_key root@<VPS_HOST>`
- Данные каждого агента — в `~/.openclaw/workspace-<agentId>/`.
- Список агентов: `ls -d ~/.openclaw/workspace-*` минус `workspace-agent27`
  (`REPORT_AGENT_ID` — служебный агент-получатель отчётов, не рабочий,
  исключён из `listAgentIds()` в `src/core/config.ts`).
- Если в вопросе не указан агент и это не воронка/discovery (см. admin-only
  ниже, они только у `agent1`) — уточнить, о каком агенте речь, либо
  агрегировать по всем папкам.

## Как выполнять запрос

Одна команда:
```
ssh -i <ключ> root@<VPS_HOST> 'sqlite3 -separator "|" <путь-к-db> "<SQL>"'
```
БД — SQLite, читать можно любым `SELECT`. Ниже — карта, какая БД/таблица
отвечает на какой вопрос.

## Карта БД (per-agent — своя копия у каждого агента)

| БД-файл | Таблица | Про что                                                                  | Ключевые поля |
|---|---|--------------------------------------------------------------------------|---|
| `tg-channels.db` | `channels` | обойдённые чаты + охват                                                  | `chatId`(PK), `title`, `lastProcessedAt`, `channelResolved`, `avg_views`, `subs_count`, `coverage_updated_at`, `chatUsername` |
| `tg-channels.db` | `dm_candidates` | кандидаты на DM из групп                                                 | `userId`, `sourceChatId`, `status`, `score`, `createdAt` |
| `tg-channels.db` | `dm_history` | журнал отправленных DM                                                   | `userId`, `sentAt`, `replyCount`, `status` |
| `tg-channels.db` | `banned_channels` | очередь забаненных каналов на выход                                      | `chatId`(PK), `detectedAt` |
| `tg-channels.db` | `channel_visits` | журнал визитов монитора (для дневного счёта охваченных/активных каналов) | `chatId`, `visitedAt`, `outcome`(empty\|active\|error), `messagesCount` |
| `tg-channels.db` | `send_errors` | журнал ошибок отправки по попытке/каналу                                 | `chatId`, `occurredAt`, `source`(monitor\|dm_send\|monitor_v2), `errorCode` |
| `tg-replies.db` | `replies` | ответы агента в группах                                                  | `chatId`, `msgId`, `sentAt` |
| `tg-replies.db` | `group_threads` | групповые треды-диалоги                                                  | `chatId`, `status`(active\|expired), `lastActivityAt` |
| `tg-replies.db` | `group_thread_agent_msgs` | индекс «сообщение агента → тред»                                         | `agentMsgId`+`chatId`(PK), `threadId`(FK) |
| `tg-replies.db` | `thread_post_dates` | дата публикации поста ветки (post-freshness-gate)                        | `chatId`+`topMsgId`(PK), `postDate` |
| `dm-threads.db` | `dm_threads` | контекстные личные диалоги                                               | `userId`(UNIQUE), `lastActivityAt` |
| `tg-join-queue.db` | `join_queue` | очередь вступления в discussion-группы                                   | `link`(UNIQUE), `status`(pending→processing→joined\|skipped\|error), `attempts` |
| `tasks.db` | `tasks` | расписание задач-скиллов                                                 | `agentId`+`type`(PK), `schedule`(cron), `enabled` |
| `tasks.db` | `runs` | журнал прогонов скиллов                                                  | `agentId`, `type`, `status`(success\|error), `durationMs`, `llmCalls` |
| `tasks.db` | `dispatcher_runs` | пиковая память прогона диспетчера                                        | `agentId`, `startedAt`, `peakRssKb` |

## Admin-only (только у `FUNNEL_ADMIN_AGENT_ID` = `agent1`)

| БД-файл | Таблица | Про что |
|---|---|---|
| `funnel.db` | `daily_stats` | дневная воронка платформы (ответы, DM, просмотры, подписчики, заявки — дельта+абсолют) |
| `funnel.db` | `channel_snapshots` | сырые снапшоты метрик каналов |
| `discovery.db` | `channels` | реестр каналов: одна строка на канал, метрики канала (`sub_count`/`avg_views`/…/`metrics_json`), `added_at` |
| `discovery.db` | `channel_assignments` | закрепление в разрезе персоны: PK `(persona, canonical_link)`, `agent_id` (nullable — NULL = пустой слот после бана до ротации) |
| `private-invites.db` | `private_invite_links` | инвайт-ссылка в приватный канал на агента, `post_updated`(0\|1) |

## Статус-модели

- **join_queue**: `pending → processing → joined | skipped | error`
- **dm_candidates**: `pending → sent | skipped | privacy_blocked | deactivated | expired`
- **group_threads**: `active → expired`
- **channel_visits.outcome**: `empty | active | error`
- **runs.status**: `success | error`

## Пример

Вопрос: «покажи статистику по очереди вступления каналов агента agent3»
→
```
ssh -i ~/.ssh/analytics_key root@<VPS_HOST> \
  'sqlite3 -separator "|" ~/.openclaw/workspace-agent3/tg-join-queue.db \
   "SELECT status, COUNT(*) FROM join_queue GROUP BY status;"'
```
