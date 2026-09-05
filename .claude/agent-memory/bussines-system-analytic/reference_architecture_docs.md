---
name: reference-architecture-docs
description: Где лежат требования/архитектура проекта (docs, openspec) и как устроена статус-модель скиллов
metadata:
  type: reference
---

Документация и спеки проекта telegram-user-tool (после рефакторинга репозитория,
актуально на 2026-06-20):
- `docs/design/<feature>/<feature>-vN.md` — design doc по фиче, версионируется
  суффиксом (`-v1`, `-v2`...); требования/User Stories для фичи кладутся рядом
  как `requirements-vN.md` (см. паттерн `docs/design/task-scheduler/` —
  `architecture-v1.md` + `requirements-v1.md` + `llm-layer-v1.md`,
  и `docs/design/funnel-tracking/` — `funnel-tracking-v1.md`/`v2.md` +
  `requirements-v2.md`).
- `docs/decisions/000N-*.md` — ADR, с `docs/decisions/README.md` как индексом.
- `docs/README.md` — оглавление базы знаний (product/backlog/architecture/
  operation/configuration/workflow/agent-playbook).
- `openspec/specs/` — нормативные спеки по способностям (напр. `funnel-metrics`,
  `funnel-report`, `task-scheduler`); `openspec/changes/archive/` — история
  принятых changes. Проект использует OpenSpec workflow (скиллы
  openspec-propose/apply/archive).
- `docs/coding-standards.md`.
- `docs/telegram-errors.md` — каталог RPC-ошибок MTProto/GramJS (три таблицы:
  аккаунт/подключение №1–10, вступление в каналы №11–21, отправка сообщений
  №22–32) со столбцами «Обработка as is»/«Обработка to be» — to-be это
  требования на доработку. Раздел «Новые сущности (to be)» описывает
  `agent_restrictions` (общая БД на все агенты, PK=agentId, banned/
  need_update_session/suspend) и per-agent append-only лог ошибок
  (skill_type/errorMessage/occured_at). Ревью проведено 2026-08-03 — см.
  `[[project_telegram_errors_catalog_review]]` для найденных неоднозначностей.

Ключевые контракты для анализа требований:
- Статус-модель скилла `SkillStatus` (`src/skills/types.ts`): `{ status: "success"|"error"; terminal?: boolean; details: Record<string,unknown> }`. На неё завязаны все 5 скиллов (monitor, dm-send, dm-replies, account-warmup, join-queue) — менять контракт только с явного согласования.
- Таблица `runs` (`src/core/db/runs.ts`): per-agent SQLite, поле `error TEXT` (NULL при success).
- Точка входа диспетчера: `src/scripts/dispatcher.ts`.
