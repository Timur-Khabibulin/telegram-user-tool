## 1. TelegramService — сигналы из одного GetFullChannel

- [x] 1.1 Добавить `getChannelGateInfo(channel) → { subscribers: number | null, linkedChatId: string | null, about: string | null }`: один `channels.GetFullChannel`, извлечь `participantsCount`, `linkedChatId`, `about`; FLOOD_WAIT → `FloodWaitError`
- [x] 1.2 Перевести candidate-гейт в `similar.ts` с `getChannelSubscribers` на `getChannelGateInfo` (число подписчиков берётся оттуда же; отдельный вызов не делать)
- [x] 1.3 Добавить `getRecentPostTexts(channel, n)` — fallback-сигнал темы: выборка истории (как `getRecentPostViews`), вернуть тексты `m.message` последних N постов; FLOOD_WAIT → `FloodWaitError`

## 2. LLM — промпт оценки темы

- [x] 2.1 Добавить в `src/llm/prompts.ts` промпт `scoreTopicRelevance(theme, text)` (образец — `scoreForDM`): инструкция вернуть JSON `{ score: 0..1, reason }`
- [x] 2.2 Точка вызова: `completeObject` со схемой `zod` `{ score: number (0..1), reason: string }`

## 3. similar.ts — гейты, тема, fail-closed

- [x] 3.1 Гейт «есть группа обсуждения»: `linkedChatId == null` → skip (причина `no_linked_chat`), до тематического гейта
- [x] 3.2 Тематический гейт после гейтов подписчиков и группы: собрать текст (`about`; при пустом/коротком `about` — `getRecentPostTexts`); нет текста → skip (`off_topic`, fail-closed)
- [x] 3.3 Вызвать `scoreTopicRelevance` через инжектированный `LlmClient`; `score > minTopicScore` → в пул, иначе skip (`off_topic`); ошибка оценки (failover исчерпан) → skip (`off_topic`, fail-closed), залогировать, в стоп-счётчик FLOOD_WAIT НЕ идёт
- [x] 3.4 Добавить `theme: string` и `minTopicScore: number` (дефолт 0.3) в `SimilarParams`; инжектировать `LlmClient` в `runSimilarDiscovery`/`collectByLevels`
- [x] 3.5 Считать отсев по причинам (`noLinkedChat`, `lowSubscribers`, `offTopic`) и вернуть в `SimilarRunResult`

## 4. Скрипт и скилл — параметры оператора

- [x] 4.1 `src/scripts/discovery-similar.ts`: аргументы `--theme` (обязателен) и `--min-topic-score` (опц., дефолт 0.3); построить `LlmClient` и передать в прогон
- [x] 4.2 Скилл `discovery-similar` (`SKILL.md` + вход в `index.ts`): спросить у оператора `theme` (обязательно) и опционально `min_topic_score`; проброс в скрипт/инструмент
- [x] 4.3 Проверить, что `theme` единая на прогон (все агенты платформы одной темы) — отдельной per-agent темы не вводить

## 5. Отчёт

- [x] 5.1 `renderSimilarReport`: показать ненулевые счётчики отсева (нет группы / тема ниже порога / мало подписчиков) рядом с «собрано N/goal»

## 6. Реестр — дата добавления

- [x] 6.1 `discovery.ts` `ensureSchema`: добавить `added_at INTEGER NOT NULL DEFAULT 0` в `CREATE TABLE`; для существующих БД — миграция через `PRAGMA table_info` + `ALTER TABLE discovered_channels ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0`
- [x] 6.2 `registerChannel`: проставлять `added_at = Math.floor(Date.now()/1000)` в `INSERT OR IGNORE` (повтор известного канала строку не трогает → дата неизменна)

## 7. Проверка

- [x] 7.1 `openspec validate discovery-similar-topic-gate --strict`
- [x] 7.2 Сверить, что защитная проверка `linkedChatId` в `joinDiscussionGroups` оставлена без изменений (инвариант join-queue не ослаблен)

## 8. v2 — уточнение тематического гейта (2026-06-22)

- [x] 8.1 `similar.ts`: убрать условие `text.length < MIN_ABOUT_LEN` — `about` + посты запрашиваются для каждого кандидата, прошедшего гейты подписчиков и группы, независимо от длины `about`
- [x] 8.2 `SimilarParams`: добавить `topicPostsCount: number` (дефолт `10`); валидация `N > 2` в точке входа (скрипт/скилл)
- [x] 8.3 Вызов `tg.getRecentPostTexts(cand.inputChannel, p.topicPostsCount)` — передавать N явно, не использовать дефолт функции (`n=5`)
- [x] 8.4 `src/llm/prompts.ts`: `scoreTopicRelevance(theme, about, posts: string[])` — новая сигнатура (было `(theme, text)`); промпт — два шага (тезис по посту → `channelTopic` + `score` по новой шкале)
- [x] 8.5 Новая шкала score в промпте: `0.8–1.0` / `0.5–0.7` / `0.2–0.4` / `0.0–0.1` (доля контента по теме), заменяет 3-ступенчатую
- [x] 8.6 `similar.ts` `topicSchema`: добавить `theses: z.array(z.string()).optional()`, `channelTopic: z.string().optional()`; `score`, `reason` — как есть
- [x] 8.7 `scoreCandidateTopic`: возвращать `{ score, channelTopic } | null` (не только число) — `channelTopic` нужен для лога
- [x] 8.8 Дефолт `minTopicScore`: `0.3 → 0.5` в `similar.ts`, `discovery-similar.ts` (`DEFAULT_MIN_TOPIC_SCORE`), `SKILL.md`
- [x] 8.9 Лог принятых кандидатов в `collectByLevels`: добавить `channelTopic` и ссылку на канал в строку лога; отклонённые — без изменений (только счётчик)
- [x] 8.10 `discovery-similar.ts`: аргумент `--topic-posts-n` (опционален, дефолт `10`), валидация `> 2`
- [x] 8.11 `SKILL.md` шаг 1: добавить опциональный параметр «число постов для оценки темы» (N, дефолт 10) в опрос оператора
- [x] 8.12 Обновить спеки (`specs/similar-channel-discovery/spec.md`, `specs/llm-layer/spec.md`) под новую сигнатуру промпта, шкалу, дефолт порога и формат лога
- [x] 8.13 `openspec validate discovery-similar-topic-gate --strict`
