# План переноса — к ADR 0007

Исполнительный план для [ADR 0007](0007-core-vs-features-split.md) (принято,
2026-09-05). Сам ADR — решение и целевая структура, не меняется. Этот файл —
рабочий чек-лист переноса, обновляется по ходу выполнения.

Прямой фикс (не OpenSpec change) — поведение системы не меняется, меняется
только структура кода.

## Зафиксированные решения по объёму

1. `agentic-session.ts`/`persona-template.ts` в `core/` не выносим —
   `tg-agent-reauth-from-tdata` после переноса зависит от
   `tg-agent-autoregistration` напрямую (feature→feature). Пересмотр — отдельная
   задача на будущее.
2. Новых тестов не пишем.
3. Деплой на VPS — один раз, в самом конце, после того как все единицы
   перенесены и проверены.
4. Перегруппировка `src/scripts/` на `periodic/`/`ops/` — отдельным шагом,
   не часть этого переноса.

## Цикл на каждую единицу переноса

1. Перенос файлов (`git mv`, сохраняя историю).
2. Правка импортов во всех потребителях (`index.ts`, `src/scripts/*`,
   `src/skills/*`, другие модули `core/`/`features/`).
3. Правка документации и OpenSpec, ссылающихся на эту единицу — сразу после
   физического переноса этой единицы, не заранее.
4. Верификация (`npx tsc --noEmit`) — перенос не должен добавлять новых ошибок
   компиляции.
5. Коммит этой единицы отдельно от остальных.

## Единицы переноса

| № | Единица | Потребители | Затронутая документация | Статус |
|---|---|---|---|---|
| 1 | `activity-percentile.ts` | 1 скрипт | нет упоминаний вовне | готово |
| 2 | `channel-preview/` | 2 скилла | нет упоминаний вовне | готово |
| 3 | `proxy/` | 3 скрипта | нет упоминаний вовне | готово |
| 4 | `channel-metrics/` | index.ts + скрипт | нет упоминаний вовне | готово |
| 5 | `channel-analysis/` | index.ts | нет упоминаний вовне | готово |
| 6 | `channel-context/` | index.ts + скилл | нет упоминаний вовне | готово |
| 7 | `discovery/` | index.ts + неск. скриптов | `docs/design/channel-discovery-similar/*.md`, `docs/design/universal-script-control/architecture.md`, `openspec/specs/similar-channel-discovery`, `channel-discovery` | не начато |
| 8 | `tg-agent-autoregistration/` | index.ts + 2 скрипта | `docs/design/tg-agent-autoregistration/architecture.md` | не начато |
| 9 | `tg-agent-reauth-from-tdata/` | index.ts (зависит от уже перенесённого №8) | нет прямых упоминаний | не начато |
| 10 | `funnel/` (`funnel-collect.ts`+`funnel-report.ts`+`runs-summary.ts`) | index.ts + скрипты | `docs/design/funnel-tracking/*.md`, `docs/design/funnel-potential-reach/*.md`, **`openspec/specs/daily-summary/spec.md`** (нормативная ссылка на функцию) | не начато |

## После всех 10 единиц

- [ ] Перегруппировка `src/scripts/` на `periodic/`/`ops/`.
- [ ] Снять пометку «физический перенос не выполнен» в `docs/architecture.md`.
- [ ] Реальная проверка (`/verify` / ручной прогон против тестового агента) по
      основным путям.
- [ ] Деплой на VPS — весь `src/` целиком, одной синхронизацией.
