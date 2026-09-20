# Воронка v3: архитектура

> **О чём документ.** Как реализовать поверх текущей кодовой базы пять
> уточнений отчёта воронки из
> [requirements-v3.md](./requirements-v3.md) (US-1…US-5 + сквозное
> требование о границах UTC+5). Парные документы: `funnel-tracking-v2.md` —
> действующий формат отчёта этапов 1-7 (эта версия точечно меняет его, не
> пересматривает целиком); `architecture-v2.md` — хранение этапов 1-4
> (`channel_visits`, `send_errors` в `tg-channels.db`) и этапов 5-7
> (`channel_snapshots`, `daily_stats` в `funnel.db`) — не меняется здесь,
> кроме снятия одного условия в §3.
>
> **Граница:** код-уровень (модули, сигнатуры функций, схемы таблиц, порядок
> вызовов), не тела функций.

---

## 0. Уже существующий механизм, на который опирается это решение

Персональные пригласительные ссылки агентов в приватный канал — предпосылка
US-3 — уже реализованы отдельным изменением (`private-invite-links`,
`src/core/db/private-invites.ts`, `src/core/telegram/service.ts`
`exportChatInvite`/`updatePersonalChannelPostLink`, инструмент
`tg_private_invite_links`): таблица `private_invite_links (agent_id TEXT
PRIMARY KEY, invite_link TEXT NOT NULL, created_at INTEGER NOT NULL)` в
`private-invites.db` (workspace `FUNNEL_ADMIN_AGENT_ID`), генерируется
оператором из чата по списку `agentIds`. Это решение переиспользует этот
реестр как есть — новой таблицы под соответствие «агент → ссылка» не
заводится.

`channel_snapshots`/`daily_stats` (`funnel.db`) уже хранят
`private_pending_requests` / `private_requests_delta`+`_abs` в разрезе
`agent_id` — колонки существовали с v1/v2, но заполнялись только для строки
`agent_id = FUNNEL_ADMIN_AGENT_ID`. Схема ничего не меняет — снимается
только условие в коде (§3).

---

## 1. US-1 — убрать медиану

Удаляются целиком, без замены:

- `medianActivityRate()` (`src/core/db/channels.ts`) и её вызов в
  `funnel-collect.ts`;
- поле `activityRateMedian` из `AgentFunnelRow`;
- `fmtActive()` и медиана в ячейке «Актив» (`funnel-report.ts`) — ячейка
  печатает `String(a.channelsActive)`;
- столбец `медиана_активности_сообщ_в_час` из CSV (`buildFunnelCsv`).

`channel_visits` (источник данных для медианы) не трогается — она остаётся
источником для `countVisitsToday` (этапы 2-3), которые не убираются.
`medianActivityRate` не имеет других вызывающих (проверено) — удаляется
полностью, не оставляется мёртвым кодом.

---

## 2. US-2 — «каналы с отправкой» вместо «сообщений отправлено»; DM исключены

### 2.1 Новый источник: разбивка по каналам вместо счёта чатов

`getDistinctRepliedChatIds` (`src/core/db/replies.ts`) заменяется на новую
функцию с той же таблицей `replies`, дающую сразу три вещи, нужные US-2 и
US-5 одним запросом (единственный вызывающий — `funnel-collect.ts`, старая
функция удаляется, не остаётся дублем):

```ts
export interface ChannelSendAgg {
    chatId: string;
    msgCount: number;
    /** MAX(replyMsgId) за окно — якорь для ссылки на канал (US-5). null, только
     *  если у всех строк группы replyMsgId не заполнен (текущий путь записи
     *  всегда его заполняет — оборонительный случай, не рабочий сценарий). */
    lastReplyMsgId: number | null;
}

/** Разбивка ответов агента по каналам за окно [startSec, endSec): DISTINCT chatId
 *  с числом сообщений и последним msgId — источник для US-2 (`.length`) и US-5
 *  (построчная разбивка), один запрос вместо двух. */
export function getChannelSendBreakdown(
    agentId: string, startSec: number, endSec: number,
): ChannelSendAgg[];
// SELECT chatId, COUNT(*) AS msgCount, MAX(replyMsgId) AS lastReplyMsgId
// FROM replies WHERE sentAt >= @startSec AND sentAt < @endSec GROUP BY chatId
```

`funnel-collect.ts`: `channelsWithSending = breakdown.length` (US-2);
`potentialReach` продолжает использовать `sumAvgViewsForRepliedChannels(agentId,
breakdown.map(b => b.chatId))` — тот же список chatId, что и раньше, только
из нового запроса. `AgentFunnelRow.groupReplies` (старое поле) переименовывается
в назначении: показывается как `channelsWithSending: number` (новое поле,
для отображения); `channelBreakdown: ChannelSendBreakdownRow[]` (новое поле,
для CSV, см. §4).

### 2.2 `groupReplies` (счёт сообщений) не удаляется — расходится с display-полем

`row.groupReplies = countSince(repliesDbPath(agentId), "replies", …)`
(текущий подсчёт, без изменений) **остаётся в коде и продолжает писаться в
`daily_stats.group_replies`** — но перестаёт использоваться в тексте/CSV
отчёта. Причина: `daily_stats.group_replies` — не только вход отчёта
воронки, это столбец B независимого скилла `funnel-stats`
(`.claude/skills/funnel-stats/`), который строит конверсию
«просмотры/ответ» = `post_views_delta / SUM(group_replies)` по всей истории
`funnel.db` на VPS. Замена смысла этого поля на «число каналов с отправкой»
задним числом сломала бы формулу конверсии за все прошлые дни без
уведомления — скилл читает `daily_stats` напрямую по SQL, не через
`funnel-report.ts`, и не может знать о смене семантики. Поэтому:

- `AgentFunnelRow.groupReplies` — остаётся, значение не меняется, **не
  отображается** ни в тексте, ни в CSV отчёта воронки;
- `AgentFunnelRow.channelsWithSending` — новое поле, отображается (US-2),
  не персистится (как остальные этапы 1-4 — пересчитывается каждый прогон,
  архитектура-v2 §5);
- `upsertDailyStats` продолжает писать `group_replies: row.groupReplies` без
  изменений — контракт с `funnel-stats` не рвётся.

### 2.3 `dmsSent` — поле не удаляется физически, перестаёт писаться из источника

`funnel-stats` не читает `daily_stats.dms_sent` (проверено — в его SQL этой
колонки нет), других читателей у неё, кроме самого отчёта воронки, нет.
Решение:

- `funnel-collect.ts` перестаёт вызывать `countSince(channelsDbPath(agentId),
  "dm_history", …)` — DM полностью исключены из сбора воронки (US-2 AC),
  источник `dm_history` для неё больше не читается;
- `AgentFunnelRow.dmsSent` — удаляется как поле сбора (нечего в него класть);
  `upsertDailyStats` продолжает передавать `dmsSent: 0` — жёстко, не
  вычисляется. Колонка `daily_stats.dms_sent` (`NOT NULL DEFAULT 0`)
  остаётся в схеме как есть, без миграции: физический `DROP COLUMN`
  не даёт никакой выгоды (колонку никто не читает), а удаление ради
  удаления добавляет риск миграции без причины. Колонка становится
  постоянно-нулевой, не «мусорной с непредсказуемым значением» — это
  осознанное состояние, не забытый хвост.
- `dm_history` как таблица и её запись (`saveDmHistory`, интерактивный
  инструмент `telegram_send_dm`) не трогаются — это не в скоупе воронки,
  DM-история используется независимо от отчёта.

### 2.4 Текст отчёта и CSV

`funnel-report.ts`: столбец «Отпр» в тексте и `каналов_с_отправкой` в CSV
показывают `a.channelsWithSending` (было `a.groupReplies + a.dmsSent`).
Легенда под таблицей меняется на «Отпр — каналов с отправкой хотя бы одного
сообщения за день; полная разбивка — в CSV». Столбец CSV
`сообщений_отправлено` переименовывается в `каналов_с_отправкой` (то же
место в списке столбцов, см. §5).

---

## 3. US-3 — заявки в приватный канал по агенту

### 3.1 MTProto: фильтр по конкретной ссылке

`TelegramService.getPendingJoinRequests` (`src/core/telegram/service.ts`)
получает необязательный параметр `link`. Поле `link?: string` подтверждено в
установленной версии GramJS (`node_modules/telegram/tl/api.d.ts`, класс
`messages.GetChatInviteImporters`) — передаётся в `Api.messages.
GetChatInviteImporters` наравне с `requested: true`:

```ts
async getPendingJoinRequests(
    channelId: string,
    opts?: { link?: string },
): Promise<{ count: number } | { error: "admin_required" }>;
// … new Api.messages.GetChatInviteImporters({ peer, requested: true, link: opts?.link,
//     offsetDate: 0, offsetUser: new Api.InputUserEmpty(), limit: 1 })
```

Без `opts.link` поведение не меняется (обратная совместимость сигнатуры).
**Проверить при реализации:** сочетание `requested: true` + `link` в
установленной версии MTProto-схемы формально валидно (оба поля — часть
одного запроса), но фактическое поведение сервера (что именно возвращает
Telegram при обоих флагах вместе) не проверялось живым вызовом — сделать
один смоук-тест на реальном агенте с реальной ссылкой перед тем как
полагаться на результат в проде.

### 3.2 Пересчёт итога — сумма по агентам, без отдельного общего запроса

Текущий блок «шаг до цикла» (`funnel-collect.ts:164-195`,
`tg.loadAccount(REPORT_AGENT_ID)` + один `getPendingJoinRequests` без
`link`) заменяется на цикл **по ссылкам активных агентов** (список активных
агентов — см. §5, доступен до этого шага):

```ts
const activeAgentIds = listAgentIds().filter(isAgentActive);          // US-4, см. §5
const links = new Map(
    listPrivateInviteLinks(adminAgentId)
        .filter((r) => activeAgentIds.includes(r.agentId))
        .map((r) => [r.agentId, r.inviteLink]),
);
const privateAbsByAgent = new Map<string, number>();

if (privateChannelId) {
    try {
        await withTimeout(async () => {
            tg.loadAccount(REPORT_AGENT_ID);
            for (const [agentId, link] of links) {
                try {
                    const pr = await tg.getPendingJoinRequests(privateChannelId, { link });
                    if ("error" in pr) { /* лог предупреждения, агент остаётся без записи в Map → «—» */ }
                    else privateAbsByAgent.set(agentId, pr.count);
                } catch (err) { /* лог предупреждения на конкретного агента, продолжить цикл */ }
            }
        }, AGENT_STAGES_5_TO_7_TIMEOUT_MS, "private channel requests by agent");
    } catch (err) {
        result.privateNote = "недоступно (ошибка запроса)"; // весь шаг не выполнен — см. §3.4
    }
}
```

Один `tg.loadAccount(REPORT_AGENT_ID)` на весь список ссылок (не на каждый
запрос) — сессия переключается один раз, как и раньше. Агент без записи в
`private_invite_links` не попадает в `links` вообще — MTProto-запрос для
него не делается (не тратим вызов на заведомо отсутствующую ссылку).

### 3.3 Запись в `funnel.db` — снимается условие `agentId === adminAgentId`

Внутри основного цикла по агентам (этапы 5-7, тот же блок, что пишет
`postViewsAbs`/`publicSubsAbs`):

```ts
row.privateRequestsAbs = privateAbsByAgent.get(agentId) ?? null;   // null → «—», не 0
const prev = getPreviousSnapshot(adminAgentId, agentId);
row.privateRequestsDelta = deltaOf(row.privateRequestsAbs, prev?.privatePendingRequests ?? null);

// insertSnapshot / upsertDailyStats — было `agentId === adminAgentId ? … : null`,
// становится безусловно per-agent:
privatePendingRequests: row.privateRequestsAbs,
privateRequestsDelta: row.privateRequestsDelta,
privateRequestsAbs: row.privateRequestsAbs,
```

Схема `channel_snapshots`/`daily_stats` не меняется — колонки уже были
per-`agent_id` (§0). `hasSnapshotForDay`/`getPreviousSnapshot` уже принимают
`agentId` параметром — вызываются так же, как для `postViewsAbs`, без
специального случая.

Побочный эффект (не новая работа, а следствие снятия условия): скилл
`funnel-stats` считает `SUM(private_requests_delta) GROUP BY date` по всей
таблице `daily_stats` — раньше это давало значение только строки agent1,
теперь автоматически даёт сумму по всем агентам, то есть именно новый
платформенный итог US-3 без каких-либо изменений в самом скилле.

### 3.4 Итог платформы и агрегатная ошибка

`FunnelResult.privateRequestsAbs`/`privateRequestsDelta` вычисляются один
раз после основного цикла как сумма по `result.agents` (null → 0 в сумме,
как того требует AC):

```ts
result.privateRequestsAbs = result.privateNote ? null
    : result.agents.reduce((s, a) => s + (a.privateRequestsAbs ?? 0), 0);
result.privateRequestsDelta = result.privateNote ? null
    : result.agents.reduce((s, a) => s + (a.privateRequestsDelta ?? 0), 0);
```

`result.privateNote` выставляется только при отказе всего шага §3.2 (сессия
`REPORT_AGENT_ID`/канал недоступны целиком) — в этом случае у всех агентов
`privateRequestsAbs = null` естественно (Map пустая), и платформенный итог
тоже `null`, а не `0` (не подменять «не собрано» на «ноль»).

### 3.5 Текст отчёта — новый столбец, не отдельная строка

**Важно, буквально по AC (не переинтерпретируется под ширину мобильного
экрана):** US-3 требует столбец «заявки по агенту» именно в текстовой
таблице отчёта, не только в CSV. Существующая узкая таблица (архитектура-v2
§3, этапы 1-4) расширяется шестым столбцом «Заяв» между «Отпр» и «Охват»,
значение — `fmtDeltaAbs(a.privateRequestsDelta, a.privateRequestsAbs)`
(готовая функция, уже даёт «—» при `abs == null`). Итоговая строка таблицы —
`fmtDeltaAbs(r.privateRequestsDelta, r.privateRequestsAbs)`.

Старая отдельная строка `Заявки в приватный канал: …` под таблицей
**убирается** — то же число теперь и так в таблице (Итого), дублировать его
второй строкой в том же сообщении избыточно («один факт — один дом»).
Взамен: если `r.privateNote` установлен (весь шаг сбора недоступен, §3.4),
печатается отдельная строка `Заявки в приватный канал: недоступно (…)` —
это не то же число ещё раз, а объяснение, почему в столбце «Заяв» у всех
агентов «—» в этот день.

**Компромисс ширины.** Добавление столбца «Заяв» (формат вида `+13 (847)`
или `—`, до ~10 символов) заметно увеличивает ширину таблицы против
целенаправленно узкого дизайна architecture-v2 §3 (расчёт на экран
телефона). Это прямое следствие буквального AC US-3, не техническая
случайность — сознательно не сужается до отдельной строки/сокращённого
формата, раз требование явно просит столбец с тем же форматом
дельта(абсолют), что у остальных метрик-снапшотов.

---

## 4. US-5 — разбивка по каналам в CSV со ссылкой

### 4.1 Данные для ссылки — новая колонка `chatUsername`, без новых MTProto-вызовов

Существующие `channels.channelId`/`channelUsername`/`channelResolved`
(`channel-content-analysis`) хранят идентичность **привязанного broadcast-
канала** обсуждения (`resolveChannelIdentityForDialog` → `resolveLinkedBroadcast`
для мегагрупп, сам канал — для broadcast-чатов) — это не то же самое, что
собственный username чата, в который агент отвечает: у обычной группы без
привязанного канала `channelResolved=1, channelId=NULL` навсегда, и для неё
эти колонки принципиально пусты. Переиспользовать их для US-5 нельзя —
семантика другая.

Собственный `username` чата уже приходит бесплатно в ответе, который
`TelegramService.listGroupChannels()` (`src/core/telegram/service.ts`) и так
получает каждый прогон монитора (`client.getDialogs({})` → `d.entity.username`
для канало-подобных диалогов) — сейчас он вычитывается и отбрасывается,
остаётся только `title`. Захват этого поля не добавляет ни одного нового
MTProto-вызова:

```ts
// было: Promise<Map<string, string>>  (chatId → title)
async listGroupChannels(): Promise<Map<string, { title: string; username: string | null }>>;
```

`syncChannels` (`src/core/db/channels.ts`) получает то же расширение сигнатуры
(`telegramChannels: Map<string, { title: string; username: string | null }>`),
`toUpdate` сравнивает оба поля (не только `title`), `INSERT`/`UPDATE`
получают `chatUsername`. Три места вызова (`index.ts`, `monitor.ts`,
`monitor-v2.ts`) передают Map дальше без изменений — сигнатура прозрачна для
них.

Новая аддитивная миграция колонки (тот же приём, что
`migrateChannelIdentityColumns`/`migrateCoverageColumns`):

```ts
function migrateChatUsernameColumn(db: Database.Database): void {
    const cols = (db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("chatUsername")) db.exec(`ALTER TABLE channels ADD COLUMN chatUsername TEXT`);
}
```

вызывается из `initChannels` рядом с двумя существующими миграциями.
**Название намеренно не `channelUsername`** — во избежание путаницы с уже
существующей колонкой того же имени с другим смыслом (привязанный
broadcast-канал); `chatUsername` = username самого чата, куда агент пишет.

### 4.2 Построение ссылки — чистая функция, без сети

```ts
// src/core/db/channels.ts, рядом с новой колонкой

/** Строки channels по списку chatId — title и chatUsername, батч-JOIN для разбивки US-5. */
export function getChatTitlesAndUsernames(
    agentId: string, chatIds: string[],
): Map<string, { title: string; chatUsername: string | null }>;
// SELECT chatId, title, chatUsername FROM channels WHERE chatId IN (...)
// (тот же приём WHERE...IN, что sumAvgViewsForRepliedChannels)

/**
 * Переходимая ссылка на чат: публичный username → t.me/<username>/<msgId>;
 * приватный канал/супергруппа (marked id с префиксом -100) → t.me/c/<internal>/<msgId>
 * (internal = marked id без префикса -100, тот же приём, что
 * channel-analysis/run.ts:postLink). Официальный формат t.me/c/ требует msgId
 * (core.telegram.org/api/links) — без msgId ссылка не строится вообще, ни в
 * одной из веток. Обычная («базовая», не супергруппа) группа — ни username,
 * ни marked id с -100 у нее нет: Telegram не даёт для таких чатов постоянной
 * ссылки в принципе, это не пробел в модели данных, а свойство типа чата.
 */
export function buildChannelUrl(
    chatId: string, chatUsername: string | null, msgId: number | null,
): string | null {
    if (msgId == null) return null;
    if (chatUsername) return `https://t.me/${chatUsername}/${msgId}`;
    if (chatId.startsWith("-100")) return `https://t.me/c/${chatId.replace(/^-100/, "")}/${msgId}`;
    return null;
}
```

`msgId` — `lastReplyMsgId` из `getChannelSendBreakdown` (§2.1): ссылка ведёт
на последнее сообщение агента в этом канале за день, не на канал «вообще» —
это даёт более полезную точку входа («перейти и увидеть само сообщение
агента»), не противоречит AC (там не указано «ссылка на канал без
привязки к сообщению», только «ссылка на канал», а ссылка на конкретное
сообщение канала — это тоже ссылка на канал).

### 4.3 Сборка в `funnel-collect.ts`

```ts
const breakdown = getChannelSendBreakdown(agentId, window.startSec, window.endSec); // §2.1
row.channelsWithSending = breakdown.length;
const chatInfo = getChatTitlesAndUsernames(agentId, breakdown.map((b) => b.chatId));
row.channelBreakdown = breakdown.map((b) => {
    const info = chatInfo.get(b.chatId);
    return {
        chatId: b.chatId,
        title: info?.title ?? b.chatId,
        url: buildChannelUrl(b.chatId, info?.chatUsername ?? null, b.lastReplyMsgId),
        msgCount: b.msgCount,
    };
});
```

`AgentFunnelRow.channelBreakdown: ChannelSendBreakdownRow[]` — новое поле, не
персистится (как и остальные этапы 1-4/US-2 показатели — пересчитывается
каждый прогон из `replies`+`channels`, ни то ни другое не теряет историю).

### 4.4 CSV — вторая таблица в том же файле

`buildFunnelCsv` (`funnel-report.ts`) дописывает вторую таблицу после
основной, разделённую пустой строкой — AC говорит «в нём» (в том же
CSV-вложении), не «отдельным файлом»:

```
agent_id,каналов_у_агента,…(основная таблица, как в §5)…

agent_id,канал,ссылка,сообщений_за_день
agent_1,"Крипта тусовка",https://t.me/c/1234567890/98765,7
agent_1,Movers Chat,https://t.me/moverschat/54321,2
```

Заголовок второй таблицы — те же прилагательные-снипеты, что и в основной
(`agent_id`, снейк-кейс). `канал` — не часть AC буквально, добавлен для
читаемости: URL приватного канала (`t.me/c/<id>/<msg>`) сам по себе не
несёт названия, а именно название — то, что нужно координатору, чтобы
«разобрать, куда именно уходят сообщения агента» (US-5, описание истории).
Название — свободный текст (может содержать запятые/кавычки), поэтому
только для этой секции CSV вводится экранирование по RFC 4180 (в отличие от
основной таблицы, где до сих пор было верно, что поля — только agent_id и
числа):

```ts
/** RFC 4180: оборачивает в кавычки и удваивает внутренние кавычки, если поле
 *  содержит запятую/кавычку/перевод строки. Нужно только для названий каналов —
 *  остальные поля отчёта (agent_id, числа, URL) не требуют экранирования. */
function csvEscapeField(s: string): string {
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
```

Канал без URL (базовая группа, §4.2) — попадает строкой в разбивку с пустой
ячейкой `ссылка` (не пропускается): у агента реально было отправление
сообщений в этот чат за день, и AC не предусматривает исключение «нет
ссылки» как повод убрать строку — убрать реальный факт отправки из-за
технического ограничения формата ссылки было бы потерей данных, не
упрощением.

---

## 5. US-4 — фильтр по активным агентам

### 5.1 Новая функция в `db/tasks.ts`

```ts
/** Активен ли агент (US-4): включён хотя бы один монитор (monitor/monitor-v2…v5)
 *  ИЛИ account-warmup на текущий момент — читает tasks.db агента, без учёта
 *  истории включённости за день. */
export function isAgentActive(agentId: string): boolean {
    return listTasks(agentId).some(
        (t) =>
            (t.type === "monitor" ||
                t.type === "monitor-v2" ||
                t.type === "monitor-v3" ||
                t.type === "monitor-v4" ||
                t.type === "monitor-v5" ||
                t.type === "account-warmup") &&
            t.enabled === 1,
    );
}
```

> Критерий с тех пор расширен: помимо мониторов всех версий агент считается
> активным и при включённом `account-warmup` — агент на прогреве (ещё без
> монитора) должен попадать в цели дискавери/распределения/ротации
> (`resolvePersonaTargets`) и в обход воронки. `isAgentActive` — общий предикат
> для обоих потоков.

Переиспользует существующий `listTasks` (уже открывает `tasks.db`,
идемпотентно создаёт схему) — не отдельный SQL-запрос, не новая БД-функция
нижнего уровня.

### 5.2 Место фильтра — самое начало `collectFunnel`, один раз

```ts
export async function collectFunnel(tg, opts, log): Promise<FunnelResult> {
    const activeAgentIds = listAgentIds().filter(isAgentActive);
    // …
    // §3.2 использует activeAgentIds для выборки ссылок
    for (const agentId of activeAgentIds) {   // было: listAgentIds()
        // … этапы 1-4, 5-7 без изменений
    }
}
```

Фильтр вычисляется один раз, до шага заявок (§3.2) и до основного цикла —
оба места используют один и тот же список, не два независимых обхода
`listAgentIds()` с риском разойтись. Неактивный агент не создаёт
`AgentFunnelRow` вообще (не «пропущен с пометкой», а полностью отсутствует)
— соответствует AC буквально (агент не должен быть виден никаким
способом, включая отдельный список/пометку). Проверка — самая первая
операция цикла, раньше любых МТProto-вызовов и любых обращений к
`tg-channels.db`/`tg-replies.db` — неактивный агент не тратит на себя
никакой работы дальше простого чтения `tasks.db`.

`REPORT_AGENT_ID` уже исключён из `listAgentIds()` (report-agent-isolation,
не меняется здесь) — фильтр `isAgentActive` применяется поверх уже
отфильтрованного списка, двойного исключения не требуется.

---

## 6. Сквозное — границы UTC+5

Ничего нового не вводится: разбивка US-5 использует тот же `window:
DayWindow` (`startSec`/`endSec` из `finishedDayWindow()`/`startOfUtcPlus5Day`,
`features/funnel/runs-summary.ts`), что и все остальные показатели отчёта — то же окно,
которым уже фильтруется `channel_visits`/`send_errors`/`replies` в
architecture-v2. Отдельного понятия границы дня для новой разбивки не
заводится.

---

## 7. Сводная модель изменений

| Модуль | Изменение |
|---|---|
| `core/db/channels.ts` | удалить `medianActivityRate`; новая колонка `chatUsername` + `migrateChatUsernameColumn`; новые `getChatTitlesAndUsernames`, `buildChannelUrl`; `syncChannels` — расширенная сигнатура Map, сравнение title+username |
| `core/db/replies.ts` | `getDistinctRepliedChatIds` → `getChannelSendBreakdown` (замена, не добавление) |
| `core/db/tasks.ts` | новая `isAgentActive` |
| `core/db/funnel.ts` | без изменений схемы — используется полнее (per-agent запись частных полей без условия) |
| `core/db/private-invites.ts` | без изменений — используется как есть (`listPrivateInviteLinks`) |
| `core/telegram/service.ts` | `getPendingJoinRequests` — новый опциональный `opts.link`; `listGroupChannels` — возвращает `{title, username}` вместо `title` |
| `features/funnel/funnel-collect.ts` | фильтр активных агентов в начале; блок заявок — цикл по ссылкам вместо одного вызова; снятие условия `agentId === adminAgentId`; сборка `channelBreakdown`/`channelsWithSending`; `dmsSent` больше не читается из `dm_history` |
| `features/funnel/funnel-report.ts` | убрать `fmtActive`/медиану; столбец «Заяв» в тексте + Итого; убрать строку-дубликат заявок (кроме `privateNote`); вторая таблица в CSV + `csvEscapeField`; переименование `сообщений_отправлено`→`каналов_с_отправкой` |
| `scripts/funnel-tracker.ts` | без изменений — читает `FunnelResult`/CSV-строку как есть |

---

## 8. Соответствие развилкам

| Развилка | Решение |
|---|---|
| Где хранить «агент → ссылка» | Не новая таблица — уже существующая `private_invite_links` (`private-invites.db`, §0) |
| Фильтр `GetChatInviteImporters` по конкретной ссылке | Параметр `link` в `getPendingJoinRequests`, подтверждён в установленной GramJS-схеме (§3.1); поведение сервера при `requested+link` вместе — проверить смоук-тестом при реализации |
| `getDistinctRepliedChatIds` для US-2 | Заменена на `getChannelSendBreakdown` — один запрос отдаёт и count (US-2), и разбивку с msgId (US-5) |
| Судьба `dmsSent` | Не читается из `dm_history` в воронке; колонка `daily_stats.dms_sent` остаётся, всегда `0`, без миграции — нет читателей вне отчёта (§2.3) |
| Место и способ фильтра активных агентов | `isAgentActive` в `db/tasks.ts`, вызывается в начале `collectFunnel` один раз, до цикла и до шага заявок (§5) |
| Ссылка на канал в US-5 | Новая колонка `chatUsername` (захват уже получаемых, но отбрасываемых данных `listGroupChannels`, без новых MTProto-вызовов) + производная `t.me/c/<id>` для приватных супергрупп/каналов; для базовых групп ссылки нет — не изъян модели, свойство типа чата Telegram (§4) |

---

## 9. Future Work

- Регенерация ссылок из `private_invite_links` при появлении нового
  активного агента — вне скоупа v3 (US-3 предпосылка явно выносит создание
  ссылок за рамки этого документа).
- Если `daily_stats.dms_sent` когда-нибудь понадобится физически убрать —
  делать отдельной миграцией, когда версия SQLite в проде гарантированно
  поддерживает дешёвый `DROP COLUMN`; сейчас не блокирует ничего (§2.3).
