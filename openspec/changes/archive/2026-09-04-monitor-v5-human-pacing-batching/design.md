## Context

`monitor-v5` (`src/skills/monitor-v5.ts`, capability `group-monitoring-v5`) уже
прошёл одну итерацию human-pacing: статус диалога снимается по одному каналу
за раз (`getPeerDialog`), а не батчем на весь набор до цикла, паузы между
каналами случайные. Но три места остаются машинными:

1. **Полная синхронизация** (`tg.listGroupChannels()` → `syncChannels()` →
   `cacheChannelIdentities()`) выполняется в начале КАЖДОГО прогона одним
   вызовом `client.getDialogs({})` без лимита — мгновенный список всех
   диалогов аккаунта.
2. **Чтение сообщений** — один вызов `getMessages(chatId, minId, limit=200)`
   на весь непрочитанный хвост, один `markAsRead(chatId, maxId)` сразу после.
3. **Typing** — длительность считается по скорости печати текста ответа
   (`V5_TYPING_CHARS_PER_SEC_MIN/MAX`, потолок `V5_TYPING_MAX_SEC=90`),
   отдельная пауза "подумать" (`V5_THINK_MIN/MAX_SEC=3-10с`) перед ней.

Выбор каналов на обработку (`getChannelsBatch(limit=V5_BATCH_LIMIT=20,
period=MONITOR_V5_CHECK_PERIOD_SECONDS)`) уже детерминирован по
`lastProcessedAt ASC` — этот порядок отбора не меняется, меняется только то,
что за один прогон он вызывается несколько раз с меньшим случайным лимитом
вместо одного раза с фиксированным.

## Goals / Non-Goals

**Goals:**
- Полная синхронизация каналов — раз в сутки, не каждый прогон; постранично,
  с паузами между страницами.
- Обработка канала батча — волнами случайного размера 10-15 вместо одного
  фиксированного батча на 20.
- Чтение непрочитанных сообщений одного чата — чанками 7-12 с паузами перед
  и между `markAsRead`, вместо одного вызова на весь хвост.
- Typing — единый случайный диапазон 60-120с вместо расчёта по длине текста.

**Non-Goals:**
- Логика классификации сообщений, генерации ответов, DM-скоринга,
  обработки ошибок отправки (`handlePostCommentSendError`) — не меняется.
- `monitor.ts` (v1), `monitor-v3.ts`, `monitor-v4.ts` — не трогаются.
- Защита от гонки между несколькими `TaskType`, включёнными на одного
  агента одновременно, — тот же принятый риск, что и в исходном
  `monitor-v5` design.md (ответственность оператора).
- Изменение отбора каналов по существу (`lastProcessedAt ASC`, статусы
  `banned`/`suspend`) — только каденс вызовов `getChannelsBatch`, не сам
  запрос.

## Decisions

**1. Хранение момента последней полной синхронизации — новая таблица
`sync_state` в той же per-agent БД (`channels.db`), не отдельный файл.**
В схеме `channels` нет места для не-per-канального состояния. Заводится
таблица-синглтон:
```sql
CREATE TABLE IF NOT EXISTS sync_state (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    lastFullSyncAt INTEGER NOT NULL DEFAULT 0
);
```
Создаётся в `initChannels()` (тот же файл `core/db/channels.ts`, тот же
паттерн `CREATE TABLE IF NOT EXISTS`, что и для `channels`/`channel_visits`/
`send_errors`). Порог due — тот же приём, что `periodSeconds` у
`getChannelsBatch`: `lastFullSyncAt = 0 OR lastFullSyncAt <= now -
V5_FULL_SYNC_PERIOD_SECONDS (86400)`. Один факт (когда был последний sync) —
один дом (БД канала, не отдельный файл состояния).
*Альтернатива отклонена*: отдельный JSON/файл состояния на агента — лишняя
сущность рядом с уже существующей БД, нарушает "один факт — один дом".

**2. Постраничный `listGroupChannels()` — `client.getDialogs({limit,
offsetDate, offsetId, offsetPeer})` в цикле до пустой страницы, вместо
`getDialogs({})` без лимита.**
Размер страницы — новая константа `V5_SYNC_PAGE_SIZE=100` (стандартный
размер страницы диалогов в Telegram/GramJS). Между страницами — пауза
`random(V5_SYNC_PAGE_DELAY_MIN_SEC=4, V5_SYNC_PAGE_DELAY_MAX_SEC=7)`.
Курсор (`offsetDate`/`offsetId`/`offsetPeer`) берётся из последнего диалога
предыдущей страницы — стандартный паттерн пагинации `messages.getDialogs` в
MTProto. **Точный набор параметров и семантику курсора нужно подтвердить по
документации GramJS перед реализацией** (agent-playbook: API по документации,
не по памяти) — в текущей кодовой базе постраничного вызова `getDialogs` ещё
нет, только вызов без лимита.

**3. Волновой отбор каналов — `while` с мягким суммарным потолком
`V5_BATCH_LIMIT`, без обрезки размера последней волны.**
```
processedThisRun = 0
while processedThisRun < V5_BATCH_LIMIT:
    wave = getChannelsBatch(limit = random(V5_WAVE_MIN=10, V5_WAVE_MAX=15))
    if wave.length == 0: break
    sleep(random(V5_WAVE_DELAY_MIN_SEC=3, V5_WAVE_DELAY_MAX_SEC=10))
    for channel of wave: … (обработка канала, как в п.4-5)
    processedThisRun += wave.length
```
Суммарный обход за прогон может превысить `V5_BATCH_LIMIT` не более чем на
размер одной волны (до +15) — осознанно принято пользователем ("не сильно
больше"), жёсткая обрезка последней волны до остатка не делается (иначе
волны переставали бы быть случайным диапазоном 10-15 и превращались в
0-15). `getChannelsBatch` сам исключает уже обработанные в этом прогоне
каналы через `lastProcessedAt`, обновляемый `markChannelProcessed` внутри
цикла обработки — повторный вызов в следующей волне естественно продолжает
с необработанных, без дополнительного состояния.

**4. Чанкинг чтения сообщений — курсор по id, `reverse` от старых к новым,
`markAsRead` по чанку.**
```
cursor = readInboxMaxId (из getPeerDialog)
totalFetched = 0
loop:
    chunk = getMessages(chatId, minId=cursor, limit=random(V5_MSG_CHUNK_MIN=7,
                         V5_MSG_CHUNK_MAX=12), order=oldest-first)
    if chunk.length == 0: break
    sleep(random(V5_MSG_MARK_DELAY_MIN_SEC=1, V5_MSG_MARK_DELAY_MAX_SEC=7))
    markAsRead(chatId, maxId=max(chunk))
    cursor = max(chunk); totalFetched += chunk.length
    if totalFetched >= V5_GET_MESSAGES_LIMIT: break   // защита от аномально
                                                        // большого backlog
    if chunk.length < requested_limit: break           // хвост вычитан
    sleep(random(V5_MSG_CHUNK_DELAY_MIN_SEC=7, V5_MSG_CHUNK_DELAY_MAX_SEC=15))
накопленные chunk'и объединяются в единый messages[] — дальше классификация
(5.3) и всё последующее работает с ним без изменений.
```
`getMessages(chatId, minId, limit)` по умолчанию отдаёт сообщения новыми
вперёд (порядок Telegram history) — для последовательного чанкинга от
старых к новым (курсор монотонно растёт вверх по id) нужен режим
`reverse`/эквивалент в GramJS. **Требует подтверждения по документации
GramJS перед реализацией** — то же предупреждение, что в Decision 2.
`V5_GET_MESSAGES_LIMIT` (200) меняет роль: было — лимит одного вызова,
станет — суммарный потолок сообщений на канал за прогон (защита от
вырожденного случая — канал с тысячами непрочитанных после простоя).

**5. Typing — единый диапазон, think-пауза убирается как отдельный шаг.**
`sendReply` вместо `sleepRandom(V5_THINK_MIN_SEC, V5_THINK_MAX_SEC)` +
расчёта по скорости печати вызывает
`showTypingFor(tg, chatId, randomBetween(V5_TYPING_MIN_SEC=60,
V5_TYPING_MAX_SEC=120), log)` — сама функция `showTypingFor` (удержание
индикатора, переотправка раз в 5с) не меняется, меняется только то, как
считается длительность на вызывающей стороне.

**6. `readingSeconds()` удаляется целиком.**
Роль полностью взяли на себя паузы Decision 4 (между `getMessages`/
`markAsRead` и между чанками) — держать вдобавок ещё и общую read-паузу по
объёму текста хвоста было бы двойным слоем пацинга без физического смысла
(согласовано с пользователем в explore).

## Risks / Trade-offs

- [Risk] Полная синхронизация раз в сутки → новый канал, в который агент
  вступил, не появится в обработке `monitor-v5` до ближайшего окна
  full-sync (до ~24ч задержки) → Mitigation: осознанный компромисс
  (запрошен явно); период настраивается константой без смены кода, если
  задержка окажется проблемой на практике.
- [Risk] Больше отдельных Telegram RPC на канал (несколько `getMessages`/
  `markAsRead` вместо одного каждого) → выше шанс наткнуться на
  `FLOOD_WAIT` в середине чтения одного канала → Mitigation:
  `withFloodRetry` уже оборачивает `getMessages`/`markAsRead`, поведение при
  повторном `FLOOD_WAIT` не меняется (аварийное завершение прогона, как
  сейчас).
- [Risk] Семантика `reverse`/курсора в GramJS `getMessages` и постраничного
  `getDialogs` — не проверена по документации на момент написания design.md
  → Mitigation: явная задача на проверку в tasks.md перед реализацией
  (agent-playbook: "Внешние ресурсы — Интернет — API и флаги подтверждать по
  документации, не по памяти").
- [Trade-off] Суммарный обход за прогон может превышать `V5_BATCH_LIMIT` до
  +15 — принято явно, не хардкапится.
- [Trade-off] Общая длительность прогона заметно растёт — по одному активному
  каналу теперь набегает: пауза после `getChannelsBatch` (до 10с, один раз на
  волну) + на каждый чанк сообщений (1-7с + 7-15с) + typing (60-120с вместо
  думания 3-10с/печати ≤90с). Похожий риск уже был учтён при переходе на
  батч 20 вместо 50 в исходном `monitor-v5` design.md ("иначе прогон не
  влезает в лимит юнита") — нужно перепроверить таймаут systemd-юнита
  (`deploy/systemd/tg-agent@.service`) под новую длительность на этапе
  реализации/раскатки, а не только на этапе дизайна.

## Migration Plan

1. Аддитивная миграция БД: таблица `sync_state` в `initChannels()`
   (`core/db/channels.ts`) — новые функции чтения/обновления
   `lastFullSyncAt`, тот же файл.
2. `core/config.ts`: добавить `V5_FULL_SYNC_PERIOD_SECONDS`,
   `V5_SYNC_PAGE_SIZE`, `V5_SYNC_PAGE_DELAY_MIN/MAX_SEC`, `V5_WAVE_MIN/MAX`,
   `V5_WAVE_DELAY_MIN/MAX_SEC`, `V5_MSG_CHUNK_MIN/MAX`,
   `V5_MSG_MARK_DELAY_MIN/MAX_SEC`, `V5_MSG_CHUNK_DELAY_MIN/MAX_SEC`,
   `V5_TYPING_MIN_SEC`; убрать `V5_READ_TAIL_MESSAGES`,
   `V5_READ_CHARS_PER_SEC_MIN/MAX`, `V5_READ_MIN/MAX_SEC`,
   `V5_THINK_MIN/MAX_SEC`, `V5_TYPING_CHARS_PER_SEC_MIN/MAX`; переопределить
   смысл `V5_TYPING_MAX_SEC` (=120) и `V5_GET_MESSAGES_LIMIT` (суммарный
   потолок на канал/прогон, не лимит одного вызова).
3. `core/telegram/service.ts`: постраничная реализация `listGroupChannels()`
   (Decision 2) — после подтверждения параметров пагинации по документации
   GramJS.
4. `src/skills/monitor-v5.ts`: перестройка шагов 3/3b (гейт по
   `lastFullSyncAt`), шага 4 (волновой цикл `getChannelsBatch`), шага 5.1c-5.2
   (чанкинг чтения), `sendReply` (typing).
5. Задеплоить — изменение затрагивает только уже включённых на `monitor-v5`
   агентов (тот же принцип, что у исходного `monitor-v5`: код неактивен, пока
   задача не назначена), новое поведение вступает в силу с ближайшего
   прогона, без ручного вмешательства.
6. Проверить фактическую длительность прогона на одном-двух агентах и
   сверить с таймаутом `tg-agent@.service` (Risks) прежде, чем считать
   раскатку завершённой.

Откат: вернуть предыдущую версию `monitor-v5.ts`/`config.ts` (git revert) —
таблица `sync_state` безвредна, если не используется, схема остаётся
обратно совместимой (аддитивная миграция).

## Open Questions

- Подтвердить по документации GramJS точный API постраничного `getDialogs`
  (Decision 2) и режим "от старых к новым" для `getMessages`/курсора
  (Decision 4) — до начала кодирования, не после.
- Фактический таймаут `tg-agent@.service` — достаточен ли под новую
  длительность прогона, или требует отдельной правки (вне скоупа этого
  change, но блокирует раскатку — см. Migration Plan п.6).
