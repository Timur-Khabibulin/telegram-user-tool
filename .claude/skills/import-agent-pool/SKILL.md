---
name: import-agent-pool
description: Bulk-import a curated CSV (agentId;link;pool_name) into discovery.db with direct per-row agent assignment (no round-robin), and lock in each agent's pool name. Use when the user has a ready channel→agent mapping file (e.g. from an external segmentation analysis like channels/health_segmented.csv) that needs importing on the VPS.
---

Заливает готовый CSV (`agentId;link;pool_name`) на VPS и прогоняет
`src/scripts/import-agent-pool.ts` — прямое назначение канал→агент (без
round-robin) плюс закрепление имени пула за агентом. См. `openspec/specs/channel-pools/`
(история и правила) и skill `vps` (тот же `ssh -i ~/.ssh/vps_key root@<VPS_HOST>`).

## Когда использовать

У пользователя есть локальный CSV с уже готовым сопоставлением канал → агент → пул
(обычно результат внешнего сегментационного анализа, пример —
`channels/health_segmented.csv`). Нужно перевести его в формат импортёра и прогнать
на проде.

## Формат входного CSV

Заголовок обязателен (первая строка всегда пропускается), разделитель — `;`:

```
agentId;link;pool_name
agent32;t.me/how2green;health|1-10k|30-100#1
agent2;t.me/somechannel;
```

- `agentId` — без пробелов, в формате платформы (`agent<N>`, не `agent N`).
- `link` — `t.me/<username>` или полная ссылка, нормализуется скриптом.
- `pool_name` — может быть пустым (совместимость со старым способом добавления без пула).

Если источник — сырой CSV с другими названиями колонок (как
`channels/health_segmented.csv`: `Канал`, `agent`, `pool_id` и т.п.), сначала
преобразовать его в этот формат (например `awk -F';'`), не изобретая новый
скрипт под каждый источник.

## Как выполнять

1. Залить CSV на VPS:
   ```
   scp -i ~/.ssh/vps_key <локальный путь к CSV> root@<VPS_HOST>:~/.openclaw/extensions/telegram-user-tool/imports/<имя>.csv
   ```
   (создать `imports/` на сервере, если нет: `ssh ... "mkdir -p ~/.openclaw/extensions/telegram-user-tool/imports"`)

2. Прогнать импорт:
   ```
   ssh -i ~/.ssh/vps_key root@<VPS_HOST> "cd ~/.openclaw/extensions/telegram-user-tool && \
     ./node_modules/.bin/tsx src/scripts/import-agent-pool.ts --file imports/<имя>.csv [--admin agent1]"
   ```

3. Убрать временный файл после успешного прогона (не оставлять CSV в `imports/` навсегда):
   ```
   ssh -i ~/.ssh/vps_key root@<VPS_HOST> "rm imports/<имя>.csv"
   ```

## Что делает скрипт (кратко)

На каждую строку: неизвестный `agentId` (нет среди `listAgentIds()`) → пропуск с
предупреждением. Непустой `pool_name` — закрепляется за агентом в `agent_pools`
(`discovery.db`) один раз; если у агента уже сохранён **другой** пул — строка
целиком пропускается (конфликт, лог-предупреждение), сам канал не трогается.
Канал: не известен реестру → регистрируется с `assigned_agent = agentId` строки
(без round-robin) и добавляется в `tg-join-queue.db`; уже известен и не забанен →
пропускается (уже размещён); уже известен и забанен → переназначается новому
агенту (`banned_at` сбрасывается), добавляется в очередь заново. `subs`/`охват`
и любые другие лишние колонки исходного CSV не парсятся и никуда не сохраняются.

## После выполнения

Показать пользователю сводку из вывода скрипта как есть: сколько строк всего,
сколько зарегистрировано, переназначено, пропущено — и по какой причине
(неизвестный агент / конфликт пула / уже активен). Напомнить, что вступление в
каналы произойдёт не сразу, а на ближайшем тике `join-queue` каждого агента, и
что колонка «пул» появится в следующем `funnel-report` (CSV-вложение).
