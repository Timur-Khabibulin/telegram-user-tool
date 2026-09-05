## 1. Создать `skills/tg-agent-create-v2/`

- [x] 1.1 Скопировать `skills/tg-agent-create/SKILL.md` в `skills/tg-agent-create-v2/SKILL.md`
      (v1 остаётся нетронутым на своём месте)
- [x] 1.2 В копии сменить frontmatter `name: tg-agent-create-v2`, обновить `description`
      (упомянуть, что это версия без регистрации агента в OpenClaw)
- [x] 1.3 Удалить шаг allowFrom (текущий «Шаг 2» v1) — `openclaw config get/set
      channels.telegram.accounts.agentsBot.allowFrom`
- [x] 1.4 Заменить шаг создания структуры (текущий «Шаг 4» v1, вызов
      `create-agent-scaffold.sh`) на прямую команду `mkdir -p
      ~/.openclaw/workspace-<agentName>/` в самом SKILL.md — отдельный скрипт для v2 не нужен
- [x] 1.5 Пересчитать нумерацию шагов после удаления allowFrom и упрощения шага структуры;
      остальные шаги (подбор прокси, авторизация сессии, запись `tg-account.json`, копирование
      `SOUL.md`, verify) переносятся без изменения поведения
- [x] 1.6 Обновить финальное сообщение пользователю — убрать упоминания регистрации/биндинга,
      если они там были

## 2. `skills/tg-agent-create-v2/scripts/verify-agent.sh`

- [x] 2.1 Скопировать `skills/tg-agent-create/scripts/verify-agent.sh` в
      `skills/tg-agent-create-v2/scripts/verify-agent.sh` (v1-версия не меняется)
- [x] 2.2 Удалить проверку A1 (агент зарегистрирован в OpenClaw через `openclaw agents list`)
- [x] 2.3 Удалить проверку A2 (`telegram_user_id` в `allowFrom`)
- [x] 2.4 Удалить проверку A3 (биндинг настроен)
- [x] 2.5 Удалить проверку B5 (agent-конфиги скопированы в `agentDir`)
- [x] 2.6 Добавить проверку существования каталога `~/.openclaw/workspace-<agentName>/`
- [x] 2.7 Оставить без изменений проверки B1 (`tg-account.json` валиден) и B2 (`SOUL.md`
      непустой)

## 3. Регистрация v2 в конфигурации

- [x] 3.1 Добавить `skills.entries["tg-agent-create-v2"]: {"enabled": true}` в `openclaw.json`
- [x] 3.2 Не трогать существующую запись `skills.entries["tg-agent-create"]` (v1 остаётся
      включённым)

## 4. Деплой и проверка

- [x] 4.1 Задеплоить `skills/tg-agent-create-v2/` (SKILL.md + scripts/verify-agent.sh) и
      обновлённый `openclaw.json` на VPS, перезапустить gateway
- [x] 4.2 Прогнать `skills/tg-agent-create-v2/scripts/verify-agent.sh` на одном из уже
      существующих агентов (созданных v1) — убедиться, что оставшиеся проверки
      (B1/B2/workspace) проходят несмотря на то, что у него ЕСТЬ регистрация в OpenClaw
      (обратная совместимость: старые агенты не ломаются от того, что новый скрипт их не
      проверяет). Прогнано на `agent1` → 3/3 OK.
- [x] 4.3 Убедиться, что `skills/tg-agent-create/` (v1) по-прежнему вызывается штатно —
      создание v2 не должно было задеть v1 ни в коде, ни в конфигурации. Прогнано на `agent1` с
      правильным `telegram_user_id` (8309001494) → 6/6 OK, v1 не задет.
