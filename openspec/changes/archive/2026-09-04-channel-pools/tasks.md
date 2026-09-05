## 1. `discovery.db` — таблица agent_pools и функции

- [x] 1.1 В `src/core/db/discovery.ts` добавить в `ensureSchema` создание `CREATE TABLE IF NOT EXISTS agent_pools (agent_id TEXT PRIMARY KEY, pool_name TEXT NOT NULL)`.
- [x] 1.2 Добавить `getAgentPool(adminAgentId, agentId): string | null`.
- [x] 1.3 Добавить `trySetAgentPool(adminAgentId, agentId, poolName): { ok: true } | { ok: false; existing: string }` — если записи нет, вставляет и возвращает `ok: true`; если есть и совпадает — `ok: true` (no-op); если есть и отличается — `ok: false` с текущим значением (для сообщения о конфликте).
- [x] 1.4 Добавить `reassignBannedChannel(adminAgentId, canonicalLink, newAgent): { reassigned: boolean }` — `UPDATE discovered_channels SET assigned_agent = ?, banned_at = NULL WHERE canonical_link = ? AND banned_at IS NOT NULL`.
- [x] 1.5 Добавить `getChannelStatus(adminAgentId, canonicalLink): { assignedAgent: string | null; bannedAt: number | null } | null` (не известен канал → null) — используется скриптом импорта для ветвления skip/reassign/register.

## 2. Скрипт импорта

- [x] 2.1 Создать `src/scripts/import-agent-pool.ts` — CLI: `--file <path> [--admin agent1]`, парсинг аргументов по образцу `discovery-add-pool.ts`/`distribute-pool.ts`.
- [x] 2.2 Реализовать построчный парсинг CSV (`agentId;link;pool_name`), `pool_name` — опциональное последнее поле (пусто/отсутствует допустимо). Поля subs/охват (если есть в строке) не парсить и не использовать.
- [x] 2.3 На каждую строку: проверить `agentId` через `listAgentIds()` — при отсутствии пропустить строку с предупреждением в лог и продолжить.
- [x] 2.4 На каждую строку с непустым `pool_name`: вызвать `trySetAgentPool`; при `ok: false` — пропустить всю строку (канал не трогать), лог предупреждения с `agentId`, текущим и полученным `pool_name`.
- [x] 2.5 Нормализовать ссылку через `normalizeChannelLink`, получить статус канала через `getChannelStatus`.
- [x] 2.6 Ветвление по статусу: не известен → `registerChannel(adminAgentId, link, agentId)` + `addJoinQueue(agentId, [link], log)`; известен и `bannedAt === null` → пропустить (лог info, канал уже размещён); известен и `bannedAt !== null` → `reassignBannedChannel(adminAgentId, link, agentId)` + `addJoinQueue(agentId, [link], log)`.
- [x] 2.7 По завершении вывести сводку: обработано строк, зарегистрировано новых, пропущено (по причинам: неизвестный агент/конфликт пула/уже активен), переназначено забаненных.

## 3. funnel-report — колонка пула

- [x] 3.1 В `src/core/funnel-collect.ts` добавить в `AgentFunnelRow` поле `poolName: string | null`.
- [x] 3.2 При сборе строки агента получить `poolName` через `getAgentPool(adminAgentId, agentId)` из `discovery.ts`.
- [x] 3.3 В `src/core/funnel-report.ts` (`buildFunnelCsv`) добавить колонку «пул» в основную таблицу: значение `a.poolName ?? "—"`; строку ИТОГО — пустая ячейка (не агрегируется).

## 4. Проверка

- [x] 4.1 Прогнать `tsc` (или используемый typecheck-скрипт) — новые файлы и правки типов проходят без ошибок. (Примечание: `tsconfig.json` уже сейчас не компилируется штатным `tsc` — `moduleResolution: "bundler"` несовместим с `module: "commonjs"`, TS5095, это pre-existing и не связано с этим change. Прогон с обходом опции подтвердил отсутствие новых ошибок в затронутых файлах.)
- [x] 4.2 Ручной прогон скрипта импорта на тестовом небольшом CSV (2-3 строки: новый канал, уже активный дубликат, забаненный канал) — проверить все три ветки и сводку. (Прогнано на временном workspace: новая регистрация, конфликт пула, неизвестный агент, и отдельно — реассайн забаненного канала. Все ветки и сводка корректны.)
- [x] 4.3 Ручной запуск `tg_funnel_report` (или скрипта воронки) — убедиться, что колонка «пул» появляется в CSV-вложении с ожидаемыми значениями и «—» для агентов без пула. (Проверено прямым вызовом `buildFunnelCsv` с тестовыми данными — колонка «пул» на своём месте, «—» при отсутствии пула, пустая ячейка в ИТОГО.)
