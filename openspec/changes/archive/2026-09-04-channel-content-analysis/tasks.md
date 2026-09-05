## 1. Расширение Telegram-сервиса

- [x] 1.1 В `service.ts` добавить выборку постов канала, возвращающую по каждому посту
  `id`, `text`, `date`, `views`, `reactions` (сумма `m.reactions.results[].count`),
  `forwards` (`m.forwards`), `comments` (`m.replies.replies`); FLOOD_WAIT → `FloodWaitError`
- [x] 1.2 Добавить метод отправки документа в Telegram (`sendFile`/`sendDocument`) с
  подписью-текстом
- [x] 1.3 Убедиться, что `getDialogs`/`ChannelHandle` отдаёт `username`, `isBroadcast` и
  `inputChannel` для каждого канала (использовать существующее, не дублировать)
  — `listDialogChannels()` уже отдаёт всё нужное, переиспользуется

## 2. LLM-тег темы

- [x] 2.1 Функция тегирования темы поста (вход — посты, выход — теги) реализована как
  `tagTopics` в core-модуле (по конвенции проекта LLM-логика живёт рядом с фичей, ср.
  `scoreCandidateTopic` в `discovery/similar.ts`); батч — один вызов на канал
- [x] 2.2 Добавить промпт `tagPostTopics` в `src/llm/prompts.ts`
- [x] 2.3 Обернуть вызов так, чтобы сбой/таймаут возвращал «нет темы», а не бросал наружу
  (fail-soft в `tagTopics`)

## 3. Core-модуль анализа

- [x] 3.1 Создать модуль оркестрации `core/channel-analysis/run.ts` (по образцу
  `discovery/similar.ts`): вход `agents`, `n`, `m`, `adminAgentId`, `llm`
- [x] 3.2 Для каждого агента: `listDialogChannels()` на его сессии, оставить только
  broadcast-каналы (`isBroadcast`) — ⚠️ ЗАМЕНЕНО группой 7: чтение идентичности из кэша
  (`channels.db`) вместо резолва на прогоне
- [x] 3.3 Получить число подписчиков (`getChannelSubsCount`) по каждому broadcast-каналу,
  отсортировать по убыванию, отобрать верхние `m%` (`ceil`, минимум 1; расчёт на агента)
  — размер по-прежнему живьём (не кэшируется)
- [x] 3.4 С отобранных каналов собрать последние `n` постов (`getRecentPosts`)
- [x] 3.5 Реализовать расчёт `ERR = forwards / views × 100%` (репосты / просмотры);
  пост без `views`/`views=0` пропускать; ноль пересылок/реакций/комментариев = 0 (не ошибка)
- [x] 3.6 Проставить тег темы каждому посту через `tagTopics`
- [x] 3.7 Сформировать ссылку на пост: `t.me/<username>/<msgId>` (публичный) либо
  `t.me/c/<internalId>/<msgId>` (приватный, без username)
- [x] 3.8 Вычислить возраст поста (`ageHours`) для колонки отчёта
- [x] 3.9 Реализовать изоляцию сбоев: try/catch по агенту и по каналу + `makeFloodAware`
  (FloodStop на 2 FLOOD_WAIT подряд), пропуск с записью причины (`SkipNote`); статистика
  прогона (агентов/каналов/постов, пропущено и почему)

## 4. Генерация и сохранение CSV

- [x] 4.1 Сформировать CSV без сторонних библиотек (`buildCsv`): одна строка = один пост;
  колонки `agent, channel, channel_size, topic, ERR, views, reactions, comments, forwards,
  age, link`; экранирование значений с запятыми/кавычками/переносами (`csvCell`)
- [x] 4.2 Добавить в `core/config.ts` `reportsDir(adminAgentId)` (workspace админ-агента);
  каталог создаётся `mkdirSync(..., { recursive: true })` перед записью
- [x] 4.3 Записать CSV `reports/channel-analysis-<UTC-timestamp>.csv` (один файл на прогон,
  все агенты — колонкой `agent`, порядок строк: группы агент → канал, без сортировки по ERR)

## 5. Доставка и интерфейс

- [x] 5.1 Сформировать короткое сообщение-статистику (`renderStats`: агентов/каналов/постов,
  пропущено с причинами)
- [x] 5.2 Отправить CSV как документ в Saved Messages админ-агента (`sendSavedDocument`) с
  подписью-статистикой; сама статистика также возвращается тулом в чат
- [x] 5.3 Зарегистрировать тул `tg_channel_content_analysis` в `index.ts` (по образцу
  `tg_discovery_similar_run`): параметры `agents`, `n`, `m`, опц. `adminAgentId`; валидация
  (`agents` непуст, `n > 0`, `m` в (0,100]); тонкая обёртка над core-модулем
- [x] 5.4 Создать операторский `skills/channel-content-analysis/SKILL.md` (по образцу
  `skills/discovery-similar/SKILL.md`): сбор параметров в чате → вызов тула → показ отчёта

## 6. Документация

- [x] 6.1 Обновить `docs/operation.md` (каталог `reports/` в данных админ-агента)

## 7. Кэширование идентичности привязанного канала (оптимизация резолва)

- [x] 7.1 `core/db/channels.ts`: в таблицу `channels` добавить колонки `channelId`,
  `channelAccessHash`, `channelUsername` и метку «без привязанного канала»; аддитивная
  миграция существующих БД (как в `db/discovery.ts` — `PRAGMA table_info` + `ALTER TABLE`)
- [x] 7.2 `core/db/channels.ts`: функции записи идентичности канала по `chatId` и выборки
  чатов, у которых идентичность ещё не определена (для инкрементального резолва)
- [x] 7.3 `core/telegram/service.ts`: метод, отдающий идентичность привязанного канала по
  чату — broadcast напрямую (`isBroadcast`), мегагруппа-обсуждение → `resolveLinkedBroadcast`;
  чат без привязанного канала → метка «без канала»
- [x] 7.4 `src/skills/monitor.ts`: на шаге синхронизации после `syncChannels` — для
  новых/непрорезолвленных чатов резолвить идентичность и сохранять; уже определённые
  (в т.ч. «без канала») не трогать; FLOOD_WAIT не должен ронять монитор
- [x] 7.5 `index.ts` (`tg_channels_sync`): зеркалить ту же логику синхронизации с резолвом
  и кэшированием идентичности
- [x] 7.6 `core/channel-analysis/run.ts`: читать идентичность из `channels.db` вместо
  `listDialogChannels()`+`resolveLinkedBroadcast`; собирать `InputChannel` из
  `channelId`+`channelAccessHash`; чаты «без канала» пропускать; размер брать живьём
- [x] 7.7 `core/channel-analysis/run.ts`: fallback при `CHANNEL_INVALID` — разовый
  пере-резолв канала по `channelUsername`
- [x] 7.8 Прогнать typecheck по затронутым файлам
