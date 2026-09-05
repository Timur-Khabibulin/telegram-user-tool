# 0007. Разделение `src/core/` на инфраструктуру и фичи

- Статус: принято
- Дата: 2026-09-05

## Контекст

`src/core/` задумывался как общее ядро — код, вызываемый обеими точками входа
(`index.ts` и standalone-диспетчер), чтобы не дублировать логику. По факту
проверки импортов на 2026-09-05 внутри `src/core/` оказались смешаны две разные
по природе вещи:

- технические примитивы и клиенты (MTProto-клиент, доступ к данным, конфигурация,
  логирование) — код, из которого строятся фичи, сам по себе не производит
  результата для пользователя;
- готовые капабилити со своей оркестрацией (`run`/`render`, конкретный результат:
  отчёт, метрика, зарегистрированный агент) — `discovery/`, `channel-analysis/`,
  `channel-metrics/`, `channel-context/`, `channel-preview/`, `proxy/`,
  `tg-agent-autoregistration/`, `tg-agent-reauth-from-tdata/`,
  `activity-percentile.ts`, `funnel-collect.ts`+`funnel-report.ts`+`runs-summary.ts`.

Критерий «используется ≥2 потребителями» (которым изначально проверялась
принадлежность к `core/`) оказался не тем критерием: часть фич тоже вызывается
и `index.ts`, и скриптами/скиллами, но остаются при этом самостоятельными
капабилити, а не инфраструктурой, на которой строится что-то ещё.

## Решение

Разделить `src/core/` на `src/core/` (только инфраструктура/клиенты) и
`src/features/` (готовые капабилити):

```
index.ts                     # OpenClaw-плагин, точка входа

src/
  core/                      # инфраструктура и технические клиенты — без своей "фичи"
    telegram/                # MTProto-клиент
    db/                      # доступ к данным
    tdata/                   # клиент формата tdata
    config.ts
    logger.ts
    errors.ts
    device-pool.ts
    scheduler-control.ts
    review-bot-api.ts        # клиент Telegram Bot API
    channel-sync.ts          # пограничный — утилита кэша
    post-comment-send.ts     # пограничный — общая бухгалтерия между фичами
    freshness-gate.ts        # пограничный — доменное правило

  features/                  # готовые капабилити со своей оркестрацией (run/render)
    discovery/                    # channel-discovery + discovery-similar
    channel-analysis/
    channel-metrics/
    channel-context/
    channel-preview/
    proxy/                        # mobile-proxy-provisioning
    tg-agent-autoregistration/
    tg-agent-reauth-from-tdata/
    activity-percentile.ts
    funnel/                       # funnel-collect.ts + funnel-report.ts + runs-summary.ts

  skills/                    # контракт диспетчера (SkillContext) => SkillStatus
                              # зовут core/ и features/, сами фичей не являются

  scripts/                   # standalone-точки входа
    dispatcher.ts
    periodic/                # daily-summary.ts, funnel-tracker.ts, review-listener.ts
    ops/                     # разовые операционные: discovery*.ts, distribute-*,
                              # backfill-*, provision-*, import-agent-pool.ts и т.п.

  llm/                       # доступ к модели
```

Критерий разделения: код относится к `core/`, если сам по себе не производит
результата для пользователя/оператора — он только даёт возможности, из которых
строятся фичи. Код относится к `features/`, если у него есть своя оркестрация
и конкретный результат (`run`/`render`, отчёт, метрика, побочный эффект вроде
регистрации агента), независимо от того, сколько точек входа его вызывают.

Исполнительный план переноса (порядок единиц, чек-лист) —
[0007-core-vs-features-split-plan.md](0007-core-vs-features-split-plan.md).

## Последствия

- Структура репозитория явно показывает, что в проекте является инфраструктурой,
  а что — самостоятельной способностью (соответствие `openspec/specs/`).
- Три модуля (`channel-sync.ts`, `post-comment-send.ts`, `freshness-gate.ts`)
  остаются в `core/` как пограничные случаи — решение по каждому можно
  пересмотреть отдельно.
- Перенос — реальный рефакторинг: правки импортов в `index.ts`, `src/scripts/*`,
  `src/skills/*`, обновление путей в `deploy/systemd/*`, зеркалирование на VPS
  (`~/.openclaw/extensions/telegram-user-tool/src/`). Не выполняется этим
  документом — только фиксирует предложенную целевую структуру.
- `src/scripts/` дополнительно группируется на `periodic/` и `ops/` — сейчас 26
  файлов плоским списком, что затрудняет ориентацию.

## Отвергнутые варианты

- Оставить как есть, только зафиксировать в документации, какие модули core
  «не соответствуют критерию core» (промежуточный вариант, применённый в
  `docs/architecture.md` 2026-09-05) — отклонено: не устраняет причину
  расхождения, только описывает её постфактум.
