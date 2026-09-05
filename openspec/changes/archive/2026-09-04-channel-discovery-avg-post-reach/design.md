## Context

`run.ts` — детерминированный HTTP-оркестратор: ищет каналы через TGStat, фильтрует, раскладывает round-robin. Основной источник охвата — TGStat `channels/stat`. При недоступности TGStat — резервный расчёт через MTProto по последним постам канала (BR-4, BR-6). Аккаунт для MTProto-расчёта задаёт оператор; без аккаунта резерв не используется.

Аналитика фичи: `docs/design/channel-discovery/channel-discovery-avg-post-reach.md`.

## Goals / Non-Goals

**Goals:**
- Добавить гейт по `avg_post_reach` через TGStat `channels/stat` в цикл отбора кандидатов.
- При недоступности TGStat — вычислять охват через MTProto с агент-аккаунтом, заданным оператором (BR-4, BR-6).
- Параметр `minAvgPostReach` опционален: при отсутствии поведение v1 без изменений.

**Non-Goals:**
- MTProto как основной (первичный) источник охвата вместо TGStat.
- Кэширование результата MTProto fallback между прогонами или внутри прогона.
- Отдельный счётчик MTProto fallback попыток в `RunResult` (BR-5 требует только общий счётчик отсева).
- Изменение схемы `discovered_channels` или `join_queue`.
- Гейт по ERR% или другим метрикам TGStat (отложено).

## Decisions

### D1. MTProto fallback при ошибке `channels/stat`, fail-closed если fallback тоже не дал данных

Если TGStat не вернул данные (HTTP-ошибка, `status != "ok"`) — поведение зависит от наличия `avgReachAgentId`:

- `avgReachAgentId` не задан → fail-closed (BR-6: без аккаунта резерв не используется).
- `avgReachAgentId` задан → вычислить охват через MTProto (D5–D8). Если MTProto тоже не дал результат → fail-closed.

Случай `tgId == null` — `channels/stat` не вызывается, система переходит в ту же ветку MTProto fallback (BR-4): username для резолва берётся из `c.link`, который всегда присутствует после проверки `if (!c.link) continue`. Подробности — D2.

**Отклонено: fail-open** — пропускать кандидата при ошибке API. Оператор задал порог, значит ожидает только каналы с подтверждённым охватом. «Нет данных» ≠ «охват достаточен».

**Отклонено: fail-closed без попытки MTProto** — терялись бы кандидаты с живой аудиторией, чьи данные TGStat временно недоступен. Потеря хуже чем дополнительный MTProto-вызов в edge case.

### D2. `tgId` из выдачи `channels/search` как `channelId` для `channels/stat`; `tgId == null` ведёт в MTProto fallback

`TgstatChannel.tgId` — Telegram ID канала, возвращается в выдаче `channels/search`. Используем его напрямую для вызова `channels/stat`.

Если `tgId == null` — `channels/stat` не вызывается (нет `channelId`), но это не немедленный fail-closed. Система входит в ту же ветку MTProto fallback (D1, BR-4): у нас есть `c.link` из выдачи TGStat, из которого извлекается username для резолва через `resolveChannelByUsername` (D6). Если и MTProto fallback не дал результат — fail-closed.

### D3. Гейт до `registerChannel`, после дедупа и подписчиков

Порядок: `isKnownChannel` → `participantsCount` → `avg_post_reach` → `registerChannel`.

Дедуп перед всеми гейтами: не тратим API-вызовы на уже известные каналы. Подписчики перед `channels/stat`: не тратим TGStat-запрос на канал, который отсеется бесплатной проверкой. `registerChannel` после всех гейтов: канал не оседает в реестре до прохождения всех условий.

### D4. `minAvgPostReach` в `RunResult` для условного рендеринга отчёта

`renderReport` принимает только `RunResult`. Чтобы показывать строку отсева только при активном гейте, `RunResult` содержит `minAvgPostReach?: number` как эхо параметра. Альтернатива — добавить параметр в сигнатуру `renderReport` — нарушает конвенцию модуля (аналогичный `renderSimilarReport` принимает только результат).

### D5. Инжекция TelegramService для MTProto fallback

`RunParams` получает опциональное поле `telegramService?: TelegramService` — готовый, уже авторизованный экземпляр сервиса. Вызывающая сторона (скрипт/скилл) отвечает за `loadAccount(avgReachAgentId)` и жизненный цикл соединения. Если `avgReachAgentId` задан — скрипт создаёт `TelegramService`, загружает аккаунт и передаёт в `RunParams`.

**Отклонено: `run.ts` сам создаёт TelegramService и вызывает `loadAccount`** — нарушает принцип одной ответственности модуля (оркестрация, не управление сессиями), затрудняет переиспользование в тестах.

**Отклонено: добавить `avgReachAgentId: string` в `RunParams` и резолвить внутри** — то же самое: `run.ts` не должен знать, как поднимать Telegram-сессию по `agentId`.

### D6. Резолв канала для MTProto fallback: по публичному username

Для вызова `getRecentPosts` нужен `Api.InputChannel` с `accessHash`. Получаем его через `resolveChannelByUsername(username)` — уже существующий метод `TelegramService`.

Username для резолва: берём из `c.link` (поле `t.me/<username>` в выдаче TGStat) — парсим стандартным способом. Если username извлечь не удалось (ссылка на приватный канал вида `t.me/+…`) — это «нет доступного идентификатора для MTProto» — MTProto fallback невозможен, fail-closed без резервного запроса. На практике каналы в выдаче `channels/search` публичные, случай редкий.

**Отклонено: использовать числовой `tgId` напрямую** — `Api.InputChannel` требует `accessHash`, которого TGStat не возвращает. `tgId` без `accessHash` непригоден для `getMessages`.

### D7. Количество постов для MTProto fallback: фиксированная константа 10

Берём последние 10 постов канала. Достаточно для стабильного среднего при умеренной нагрузке на MTProto. Аналог: `channel-coverage-update.ts` использует 11 постов для покрытия; `similar.ts` — параметрический, но там это основной источник данных.

Параметр в `RunParams` не добавляем: MTProto fallback — edge case, оператору не нужен контроль над числом постов. Константа выражает намерение («несколько последних публикаций»).

### D8. Охват = 0 у всех постов — отсеиваем как fail-closed

Если у всех полученных постов `views = 0` (новый канал, приватный, счётчики недоступны) — среднее равно 0. При любом ненулевом `minAvgPostReach` условие `avgPostReach <= minAvgPostReach` истинно → кандидат отсеивается.

Специальная ветка не нужна: поведение уже покрыто существующим сравнением. Семантика корректна: «нет данных о просмотрах» = «охват не подтверждён» = отсев.

## Risks / Trade-offs

**Расход квоты TGStat на `channels/stat`.**
Число вызовов = кандидаты после дедупа и гейта подписчиков (до достижения `target`). При агрессивных прогонах и низком `min_subscribers` может быть значительным. На первой итерации без sleep — если TGStat вернёт 429, добавить паузу в `callApi`. Оператор контролирует расход через TGStat-кабинет.

**MTProto fallback увеличивает время прогона при массовых сбоях TGStat.**
Каждый кандидат с ошибкой TGStat — дополнительный `resolveChannelByUsername` + `getMessages` через MTProto. При системной недоступности TGStat прогон замедляется пропорционально числу кандидатов. Риск принят: сбой TGStat — редкость; при нём оператор видит замедление в логах.

**FLOOD_WAIT при MTProto fallback.**
`resolveChannelByUsername` и `getRecentPosts` могут вернуть `FloodWaitError`. `run.ts` не реализует retry при FloodWait (как в `joinDiscussionGroups`). При получении FloodWaitError в MTProto fallback — логируем, кандидат отсеивается (fail-closed), прогон продолжается. Добавлять ожидание в цикле отбора нецелесообразно: один FloodWait в fallback не должен блокировать весь прогон.

**`avg_post_reach = 0` для новых каналов (TGStat).**
TGStat может вернуть `avg_post_reach: 0` для каналов с коротким историческим окном. Канал отсеивается при любом ненулевом пороге. Оператора предупреждать в SKILL.md.

**`tgId: null` в выдаче `channels/search`.**
Поле уже nullable в `TgstatChannel`. По D2, такие кандидаты перенаправляются в MTProto fallback — не fail-closed немедленно. Если и MTProto не дал результат (или `avgReachAgentId` не задан) — учитываются в `rejectedByAvgReach`. Если доля `tgId == null` велика — логировать предупреждение.
