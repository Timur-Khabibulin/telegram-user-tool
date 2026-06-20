# Архитектура репозитория (код)

Документ описывает компоненты кода и структуру репозитория.

## Компонентная архитектура

Система построена на общем ядре `src/core/` с двумя точками входа: OpenClaw-плагин
для интерактивных вызовов и standalone-диспетчер для запуска задач по расписанию.
Оба входа используют одни и те же компоненты ядра, поэтому логика не дублируется.

Это платформа на несколько агентов: у каждого агента свой каталог данных и персона,
диспетчер запускается отдельно на каждого агента (`--agent <id>`).

| Компонент | Расположение | Ответственность |
|---|---|---|
| OpenClaw-плагин | `src/index.ts` | регистрация инструментов, описание параметров (TypeBox), обёртка результата в формат OpenClaw |
| Диспетчер | `src/scripts/dispatcher.ts` | прогон агента: выбор назревших задач, последовательный вызов скиллов, запись прогонов, отчёт |
| Периодические скрипты | `src/scripts/daily-summary.ts`, `src/scripts/funnel-tracker.ts` | дневная сводка прогонов и сбор метрик воронки |
| Скиллы | `src/skills/*` | реализация задач: `monitor`, `dm-send`, `dm-replies`, `account-warmup`, `join-queue` |
| LLM-клиент | `src/llm/client.ts`, `src/llm/prompts.ts` | доступ к модели (`complete`, `completeObject`) и промпты скиллов |
| Ядро Telegram | `src/core/telegram/service.ts` | MTProto-операции поверх GramJS, клиент и `peerCache` |
| Слой данных | `src/core/db/*` | SQLite-модули (`better-sqlite3`) |
| Управление расписанием | `src/core/scheduler-control.ts` | связь таблицы `tasks` с systemd-таймером агента |
| Сводки и воронка | `src/core/runs-summary.ts`, `src/core/funnel-collect.ts`, `src/core/funnel-report.ts` | агрегация прогонов, сбор и рендер воронки |
| Конфигурация | `src/core/config.ts` | модель `AccountConfig`, пути к данным агента, константы воронки |
| Инфраструктура | `src/core/logger.ts`, `src/core/errors.ts` | логирование и форматирование ошибок |

Зависимости: плагин и диспетчер зависят от ядра (`telegram`, `db`) и LLM-клиента.
Скилл получает зависимости через `SkillContext` (`agentId`, `persona`, `tg`, `llm`,
`log`) и не зависит от OpenClaw. Скиллы вызываются диспетчером по реестру
`TaskType → скилл`.

## Структура репозитория

```
src/
  index.ts      OpenClaw-плагин (точка входа)
  scripts/      standalone-точки входа: диспетчер и периодические задачи
  skills/       реализация задач
  llm/          доступ к LLM
  core/         ядро без зависимости от OpenClaw
    telegram/   MTProto поверх GramJS
    db/         слой данных (SQLite)

skills/    SKILL.md — наследие до переноса логики в код (см. backlog)
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
| `replies.ts` | `replies`, `group_threads`, `group_thread_agent_msgs` | ответы агента и треды диалогов в группах |
| `dm-threads.ts` | `dm_threads` | контекст личных диалогов |
| `dm-history.ts` | `dm_history` | устаревшая история DM (заменяется `dm_threads`) |
| `join-queue.ts` | `join_queue` | очередь вступления в группы обсуждений |
| `tasks.ts` | `tasks` | расписание задач агента |
| `runs.ts` | `runs` | журнал прогонов |
| `funnel.ts` | `channel_snapshots`, `daily_stats` | метрики воронки (только у админ-агента) |
