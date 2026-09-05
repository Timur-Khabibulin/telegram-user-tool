## 1. Реестр `discovery.db`

- [x] 1.1 Модуль `src/core/db/discovery.ts` (better-sqlite3, путь в workspace админ-агента, `CREATE TABLE IF NOT EXISTS discovered_channels (canonical_link TEXT PRIMARY KEY, assigned_agent TEXT NOT NULL)`)
- [x] 1.2 Функция нормализации ссылки → `canonical_link` (`https://t.me/<username>`, lowercase, без `@`/хвостового `/`)
- [x] 1.3 API реестра: проверка наличия (дедуп) и вставка `(canonical_link, assigned_agent)` с возвратом «вставлено/уже было»
- [x] 1.4 Путь к `discovery.db` в `config.ts` (по аналогии с `funnelDbPath`)

## 2. Источник TGStat

- [x] 2.1 Клиент TGStat: поиск по ключевому слову (`channels/search`, до 100, `link` + `participants_count` из выдачи)
- [x] 2.2 Гейт ER: `channels/stat.err_percent` (ERR %) на канал — готовая метрика вместо расчёта из постов (см. design.md)
- [x] 2.3 Токен TGStat — заглушка в config (`TGSTAT_API_TOKEN`, env `TGSTAT_TOKEN`)

## 3. Discovery-скрипт (отбор и раскладка)

- [x] 3.1 Аргументы: `keywords[]`, `N`, `min_subscribers`, `er_min`, `agents[]` (по умолчанию `listAgentIds()`)
- [x] 3.2 Инкрементальный цикл: по словам → кандидаты, дедуп против реестра, гейт по подписчикам, гейт по ER; стоп при наборе `N` или исчерпании пространства
- [x] 3.3 Round-robin раскладка набранных каналов по агентам
- [x] 3.4 На канал: вставка в реестр (`assigned_agent`) → `addJoinQueue(assigned_agent, [canonical_link], log)` той же нормализованной ссылкой
- [x] 3.5 Сводный отчёт: найдено/распределено по агентам, достигнут ли `N`, явный shortfall при исчерпании

## 4. OpenClaw-скилл discovery

- [x] 4.1 OpenClaw-скилл `skills/channel-discovery/SKILL.md`: ввод сферы → генерация ключевых слов → уточнение оператором (Шаги 1–2)
- [x] 4.2 Скилл собирает пороги `N`/`min_subscribers`/`er_min` и поясняет ER (ERR %, 0–100) до запроса `er_min` (Шаг 3)
- [x] 4.3 Тул `tg_discovery_run` (index.ts → core/discovery/run) — детерминированный прогон; скилл вызывает его (Шаг 4) и показывает отчёт (Шаг 5)

## 5. Backfill (разовый, ручной)

- [x] 5.1 Утилита заноса в реестр известных каналов: вступлённые каналы (`status='joined'`) из `join_queue` каждого агента (`scripts/discovery-backfill.ts`, `getJoinedLinks`)
- [x] 5.2 Инструкция оператору по ручному заносу (`--manual`) + runbook в `docs/operation.md`

## 6. Проверка

Тест-раннера в проекте нет; тестирование по решению оператора не проводится. Проверка
отложена до прогона с реальным токеном TGStat (сейчас заглушка).

- [x] 6.4 `docs/` синхронизированы с кодом (аналитика §3.4/3.5, `operation.md`, `configuration.md`)
