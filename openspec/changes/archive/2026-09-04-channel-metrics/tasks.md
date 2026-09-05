## 1. TelegramService: isBroadcast и вынесенная формула охвата

- [x] 1.1 Добавить поле `isBroadcast: boolean` в тип `ChannelHandle` (`src/core/telegram/service.ts`)
- [x] 1.2 Заполнять `isBroadcast` из `channel.broadcast` в `resolveChannelByUsername`
- [x] 1.3 Вынести формулу среднего охвата (`slice(1,11)` + среднее, `null` при < 2 постов) в переиспользуемую функцию `computeAvgViews(posts: ChannelPost[]): number | null`
- [x] 1.4 Обновить `src/scripts/channel-coverage-update.ts` на использование `computeAvgViews` вместо инлайн-формулы; убедиться, что поведение (значения `avg_views`) не изменилось

## 2. Скрипт channel-metrics.ts: разбор входа и резюмируемость

- [x] 2.1 Создать `src/scripts/channel-metrics.ts` с CLI-параметрами `--input`, `--output`, `--agent` (все обязательны, ошибка при отсутствии любого)
- [x] 2.2 Реализовать чтение входного CSV, извлечение колонки `link`; ошибка и остановка без изменения `--output`, если колонки `link` нет
- [x] 2.3 Реализовать чтение существующего `--output` (если файл есть) и построение множества уже обработанных ссылок по `normalizeChannelLink` (переиспользовать из `src/core/db/discovery.ts`)
- [x] 2.4 Реализовать построчную (append) запись результата в `--output` — заголовок пишется один раз при создании нового файла, далее только data-строки

## 3. Скрипт channel-metrics.ts: расчёт метрик на канал

- [x] 3.1 Реализовать резолв ссылки: приватные ссылки без username (не резолвится в username через `normalizeChannelLink`/парсинг) сразу дают строку с пустыми метриками и `error`, без MTProto-вызова
- [x] 3.2 Вызов `resolveChannelByUsername`; при `null` — строка с пустыми метриками и `error="канал не найден"`
- [x] 3.3 Вызов `getChannelGateInfo(inputChannel)` → `subs_count = subscribers`, `comments_open = linkedChatId != null`
- [x] 3.4 Вызов `getRecentPosts(inputChannel, 11)` → `avg_views = computeAvgViews(posts)`
- [x] 3.5 Собрать и записать строку `link,subs_count,avg_views,comments_open,is_broadcast,error` (пустой `error` при успехе)

## 4. Пейсинг и FLOOD_WAIT

- [x] 4.1 Добавить паузу между MTProto-вызовами (0.8–1.2 с, по образцу `pacingMs()` из `src/core/channel-analysis/run.ts`)
- [x] 4.2 Реализовать circuit-breaker: 2 подряд `FLOOD_WAIT` → остановка всего прогона (по образцу `makeFloodAware`/`FloodStop`), уже записанные строки в `--output` сохраняются
- [x] 4.3 Загрузка сессии агента (`tg.loadAccount(agentId)`) и корректное закрытие соединения (`tg.disconnect()`) при нормальном завершении, ошибке и остановке по `FLOOD_WAIT`

## 5. Claude Code skill

- [x] 5.1 Создать `.claude/skills/channel-metrics/SKILL.md` по образцу `.claude/skills/vps/SKILL.md` и `.claude/skills/funnel-stats/SKILL.md`: инструкции по загрузке `--input` на VPS, запуску `tsx src/scripts/channel-metrics.ts` с нужным `--agent`, скачиванию `--output` обратно
- [x] 5.2 Указать в SKILL.md поведение при повторном запуске (резюмируемость) и что делать при остановке по `FLOOD_WAIT` (повторный запуск с тем же `--output`)
