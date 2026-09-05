# Архитектура репозитория (код)

Документ описывает компоненты кода и структуру репозитория.

## Компонентная архитектура

Система построена на ядре `src/core/` и двух точках входа: OpenClaw-плагин для
интерактивных вызовов и standalone-диспетчер для запуска задач по расписанию.
Модуль относится к `core/`, если его вызывают минимум два разных потребителя
(точки входа, скиллы, скрипты) — так логика не дублируется. Три модуля физически
лежат в `core/`, но по факту имеют только одного потребителя и общими не
являются (см. таблицу ниже, колонка «Ответственность»): `proxy/`,
`channel-preview/`, `activity-percentile.ts`.

Это платформа на несколько агентов: у каждого агента свой каталог данных и персона,
диспетчер запускается отдельно на каждого агента (`--agent <id>`).

| Компонент | Расположение | Ответственность |
|---|---|---|
| OpenClaw-плагин | `index.ts` | регистрация инструментов, описание параметров (TypeBox), обёртка результата в формат OpenClaw |
| Диспетчер | `src/scripts/dispatcher.ts` | прогон агента: выбор назревших задач, последовательный вызов скиллов, запись прогонов, отчёт |
| Периодические скрипты | `src/scripts/daily-summary.ts`, `src/scripts/funnel-tracker.ts` | дневная сводка прогонов и сбор метрик воронки |
| Review-listener | `src/scripts/review-listener.ts` | персистентный процесс (не по расписанию, `Restart=always`) — единственный потребитель `getUpdates` общего Bot API-бота ручного ревью комментариев (post-comment-review); на «Да»/«Нет» поднимает MTProto-сессию нужного агента по `agentId` |
| Пост-отправочная обвязка | `src/core/post-comment-send.ts` | общая для `monitor-v3`, `monitor-v4`, `monitor-v5` и `review-listener`: бухгалтерия успешной отправки комментария и классификация ошибок отправки |
| Bot API (ревью) | `src/core/review-bot-api.ts` | единственный модуль, вызывающий Telegram Bot API — адресат захардкожен в `TELEGRAM_REVIEW_CHAT_ID`, других вызывающих путей нет |
| Скиллы | `src/skills/*` | реализация задач: `monitor`, `monitor-v2`, `monitor-v3`, `monitor-v4`, `monitor-v5`, `dm-send`, `dm-replies`, `account-warmup`, `join-queue`, `channel-cleanup`, `channel-context`, `leave-banned-channels` |
| Операционные скрипты | `src/scripts/*` (кроме перечисленных выше) | разовые ручные операции оператора над данными/агентами, не по расписанию: `discovery*.ts`, `distribute-*.ts`, `backfill-*.ts`, `provision-*.ts`, `import-agent-pool.ts` и др. |
| LLM-клиент | `src/llm/client.ts`, `src/llm/prompts.ts` | доступ к модели (`complete`, `completeObject`) и промпты скиллов |
| Ядро Telegram | `src/core/telegram/service.ts` | MTProto-операции поверх GramJS, клиент и `peerCache` |
| Гейт свежести | `src/core/freshness-gate.ts` | `monitor-v2`: проверка R1/R2/R3 по дате публикации поста ветки |
| Слой данных | `src/core/db/*` | SQLite-модули (`better-sqlite3`) |
| Управление расписанием | `src/core/scheduler-control.ts` | связь таблицы `tasks` с systemd-таймером агента |
| Сводки и воронка | `src/core/runs-summary.ts`, `src/core/funnel-collect.ts`, `src/core/funnel-report.ts` | агрегация прогонов, сбор и рендер воронки |
| Конфигурация | `src/core/config.ts` | модель `AccountConfig`, пути к данным агента, константы воронки |
| Инфраструктура | `src/core/logger.ts`, `src/core/errors.ts` | логирование и форматирование ошибок |
| Массовая регистрация агентов | `src/core/tg-agent-autoregistration/*`, `src/core/tdata/*` | из tdata-сессий (закупленных заранее аккаунтов) — до готового `workspace-agent<N>`; только интерактивный тул (`tg_agent_autoregistration_run`), не задача диспетчера; см. `docs/design/tg-agent-autoregistration/` |
| Реавторизация агента | `src/core/tg-agent-reauth-from-tdata/*` | реавторизация существующего агента через уже имеющуюся у него tdata-сессию; потребители — `index.ts` и `src/scripts/tg-agent-autoregistration-retry-code.ts` |
| Поиск каналов | `src/core/discovery/*` | оркестрация channel-discovery (клиент TGStat), обход графа похожих каналов (channel-discovery-similar); потребители — `index.ts` и `src/scripts/discovery*.ts` |
| Анализ каналов | `src/core/channel-analysis/*`, `src/core/channel-metrics/*`, `src/core/channel-context/*` | анализ контента топ-каналов агента, метрики произвольного списка каналов, фоновый анализ содержания каналов агента; потребители — `index.ts` и соответствующие скрипты/скиллы |
| Синхронизация идентичности каналов | `src/core/channel-sync.ts` | наполнение кэша идентичности привязанных каналов; потребитель — `index.ts` |
| Каталог устройств | `src/core/device-pool.ts` | модели устройств для fingerprint новых агентов; потребители — `telegram/service.ts`, `tg-agent-autoregistration/` (внутри `core/`) |
| **Прокси** (не соответствует критерию core — единственный потребитель) | `src/core/proxy/*` | подбор и провижининг мобильных прокси (asocks.com), уникальность между агентами; единственный потребитель — `src/scripts/{diag-proxy-connect,provision-mobile-proxy,provision-proxy-for-new-agent}.ts` |
| **Превью канала** (не соответствует критерию core — единственный потребитель) | `src/core/channel-preview/*` | публичное веб-превью канала без авторизации (channel-post-watch); единственный потребитель — `src/skills/monitor-v3.ts`, `monitor-v4.ts` |
| **Активность канала** (не соответствует критерию core — единственный потребитель) | `src/core/activity-percentile.ts` | расчёт p50/p90 уникальных отправителей сообщений за скользящее окно 7 дней; единственный потребитель — `src/scripts/channel-activity-update.ts` |

Зависимости: плагин и диспетчер зависят от ядра (`telegram`, `db`) и LLM-клиента.
Скилл получает зависимости через `SkillContext` (`agentId`, `persona`, `tg`, `llm`,
`log`) и не зависит от OpenClaw. Скиллы вызываются диспетчером по реестру
`TaskType → скилл`.

## Способы запуска скиллов

| Вариант | Сервис | Тип процесса | Ограничения |
|---|---|---|---|
| Диспетчер (основной) | `tg-agent@{id}.service` | oneshot, root | `TimeoutStartSec=3600` |
| OpenClaw-плагин | `openclaw` | долгоживущий, root | **лимит 1 час на выполнение одного инструмента** |
| Командная строка | SSH-сессия | одноразовый | только для отладки, не целевой режим |

## Структура репозитория

```
index.ts        OpenClaw-плагин (точка входа)
src/
  scripts/      standalone-точки входа: диспетчер и периодические задачи
  skills/       реализация задач
  llm/          доступ к LLM
  core/         ядро без зависимости от OpenClaw
    telegram/   MTProto поверх GramJS
    db/         слой данных (SQLite)

skills/    SKILL.md — наследие до переноса логики в код (см. decisions/0001)
deploy/    systemd-юниты
openspec/  спецификации и изменения
docs/      база знаний
```

## Слой данных

Модули `src/core/db/` работают с SQLite через `better-sqlite3`. Каждый модуль
управляет своими таблицами:

| Модуль (`core/db/`) | Таблицы | Данные |
|---|---|---|
| `channels.ts` | `channels`, `dm_candidates` | каналы и состояние их обработки; очередь DM-кандидатов |
| `replies.ts` | `replies`, `group_threads`, `group_thread_agent_msgs`, `thread_post_dates` | ответы агента, треды диалогов в группах; кеш дат публикации постов веток (`monitor-v2`, 30 дней) |
| `dm-threads.ts` | `dm_threads` | контекст личных диалогов |
| `dm-history.ts` | `dm_history` | устаревшая история DM (заменяется `dm_threads`) |
| `join-queue.ts` | `join_queue` | очередь вступления в группы обсуждений |
| `tasks.ts` | `tasks` | расписание задач агента |
| `runs.ts` | `runs` | журнал прогонов |
| `error-log.ts` | `error_log` | append-only лог срабатываний ошибок аккаунта (per-agent) |
| `agent-restrictions.ts` | `agent_restrictions` | ограничения агентов платформы (одна БД на всю платформу, в workspace админ-агента) |
| `funnel.ts` | `channel_snapshots`, `daily_stats` | метрики воронки (только у админ-агента) |
| `pending-reviews.ts` | `pending_reviews` | очередь ручного подтверждения комментариев перед отправкой (post-comment-review); статус (pending/approved/rejected) хранится в той же строке, отдельного лога решений нет |
