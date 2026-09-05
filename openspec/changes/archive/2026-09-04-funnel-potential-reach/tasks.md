## 1. Слой данных — replies.ts

- [x] 1.1 Добавить `import * as fs from "fs"` в `src/core/db/replies.ts` (нужен для existsSync в новой функции)
- [x] 1.2 Реализовать `getDistinctRepliedChatIds(agentId: string, startSec: number, endSec: number): string[]` в `src/core/db/replies.ts` — открывает repliesDbPath(agentId) readonly, возвращает `[]` если файл не существует; иначе `SELECT DISTINCT chatId FROM replies WHERE sentAt >= @startSec AND sentAt < @endSec`

## 2. Слой данных — channels.ts

- [x] 2.1 Реализовать `sumAvgViewsForRepliedChannels(agentId: string, chatIds: string[]): number` в `src/core/db/channels.ts` — возвращает `0` если `chatIds` пустой или файл не существует; иначе строит IN-плейсхолдеры динамически (`chatIds.map(() => "?").join(",")`) и выполняет `SELECT COALESCE(SUM(avg_views), 0) AS potential_reach FROM channels WHERE chatId IN (...) AND avg_views IS NOT NULL`

## 3. Сбор данных — funnel-collect.ts

- [x] 3.1 Добавить поле `potentialReach: number` в интерфейс `AgentFunnelRow` после поля `sendErrors`
- [x] 3.2 Добавить `potentialReach: 0` в инициализацию объекта `row` в функции `collectFunnel`
- [x] 3.3 Добавить импорт `getDistinctRepliedChatIds` из `"./db/replies"` и `sumAvgViewsForRepliedChannels` из `"./db/channels"` в начало файла
- [x] 3.4 В try-блоке этапов 1-4 функции `collectFunnel`, после строки с `row.groupReplies`, добавить вычисление: `const repliedChatIds = getDistinctRepliedChatIds(agentId, window.startSec, window.endSec)` и `row.potentialReach = sumAvgViewsForRepliedChannels(agentId, repliedChatIds)`

## 4. Рендер отчёта — funnel-report.ts

- [x] 4.1 В функции `renderFunnel`: добавить `"Охват"` шестым элементом в `header`; добавить `String(a.potentialReach)` шестым элементом в каждую строку `dataRows`; вычислить `totReach = r.agents.reduce((s, a) => s + a.potentialReach, 0)` рядом с остальными `tot*`-переменными; добавить `String(totReach)` шестым элементом в `totalRow`
- [x] 4.2 В функции `renderFunnel`: добавить строку `"Охват — потенциальный охват (avg_views каналов с ответами)"` в блок легенды после строки про `"Отпр"`
- [x] 4.3 В функции `buildFunnelCsv`: добавить `"потенциальный_охват"` в `header` после `"ошибок_отправки"`; добавить `String(a.potentialReach)` в каждую строку `rows` на той же позиции; добавить `String(sum((a) => a.potentialReach))` в строку `total` на той же позиции
