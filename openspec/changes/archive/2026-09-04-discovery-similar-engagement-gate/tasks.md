## 1. Расчёт вовлечённости кандидата

- [x] 1.1 В `src/core/discovery/similar.ts` добавить функцию, считающую `avgViews` и `ER`
  кандидата: `getRecentPosts(channel, 20)` → отбросить 2 самых свежих поста → average
  просмотров по оставшимся (до 18, выборка может быть короче) → `ER = avgViews / subscribers`.
  Закреплённые посты не фильтровать.
- [x] 1.2 Пустая выборка после отбрасывания 2 свежих постов (≤2 постов у кандидата) →
  функция возвращает признак "нет данных" (fail-closed для гейта).

## 2. Гейт кандидата

- [x] 2.1 В `collectByLevels` добавить вызов гейта вовлечённости между проверкой группы
  обсуждения и `scoreCandidateTopic`.
- [x] 2.2 Кандидат отсеивается, если `avgViews <= minAvgViews` ИЛИ `er <= minEngagementRate`,
  либо выборка пуста (fail-closed) — без вызова `scoreCandidateTopic`.
- [x] 2.3 Добавить `lowEngagement: number` в `SkipCounts` (`similar.ts:106-109`) — один
  агрегированный счётчик на обе причины отсева, инкремент ровно один раз при отсеве.
- [x] 2.4 Дополнить строку лога принятого кандидата (`similar.ts:352`) рассчитанными `ER` и
  `avgViews`.
- [x] 2.5 Дополнить `renderSimilarReport` строкой с `lowEngagement` (по аналогии с
  `lowSubscribers`/`noLinkedChat`/`offTopic`).

## 3. Параметры

- [x] 3.1 Добавить `minEngagementRate?: number` (дефолт `0.1`) и `minAvgViews: number`
  (обязателен) в `SimilarParams`.
- [x] 3.2 В `src/scripts/discovery-similar.ts` добавить CLI-флаги `--min-er` (опционален) и
  `--min-avg-views` (обязателен); добавить `--min-avg-views` в валидацию обязательных
  аргументов по аналогии с `--theme`/`--agents` (`discovery-similar.ts:56-71`).

## 4. Seed-приоритизация — окно по числу постов

- [x] 4.1 В `gatherAndScoreSeeds` (`similar.ts:213-229`) заменить date-based окно
  (`engagementWindowDays`/`sinceUnixTs`) на count-based: последние посты минус 2 самых
  свежих, тем же правилом, что у гейта кандидата (п. 1.1). Агрегация остаётся `median`
  (не average).
- [x] 4.2 Переосмыслить/переименовать параметр `engagementWindowDays` в `SimilarParams`
  (`similar.ts:94`) под count-семантику; обновить проброс через `RunSimilarParams` и CLI-флаг
  скрипта, если имя меняется.

  Решение: параметр удалён целиком (а не переименован) — окно (20 постов минус 2 свежих)
  стало общей константой (`ENGAGEMENT_POSTS_SAMPLE`/`ENGAGEMENT_SKIP_FRESH`), используемой
  и гейтом кандидата, и seed-приоритизацией, а не операторским параметром. `--window-days`
  убран из CLI. Заодно удалён ставший неиспользуемым `TelegramService.getRecentPostViews`
  (заменён на `getRecentPosts` + общий хелпер выборки).

## 5. Документация скилла

- [x] 5.1 Обновить `skills/discovery-similar/SKILL.md` шаг 1 — добавить вопрос про
  `minAvgViews` (обязателен) и `minEngagementRate` (опционален, дефолт `0.1`); снять пометки
  "план, ожидает реализации" у этих пунктов.
- [x] 5.2 Обновить шаг 2 — `minEngagementRate`/`minAvgViews` в сигнатуре
  `tg_discovery_similar_run` без пометки "план".
- [x] 5.3 Обновить шаг 3 — причина отсева "низкая вовлечённость" в перечне причин отчёта без
  пометки "план".
- [x] 5.4 Обновить формулировку окна вовлечённости отправных точек в шаге 1 (дни → число
  постов) — параметр убран, формулировка отражает общее оконное правило без даты.

## 6. Регистрация инструмента (вне исходного списка задач, обязательно для рантайма)

- [x] 6.1 Обновить `index.ts` (регистрация `tg_discovery_similar_run`): убрать
  `engagementWindowDays` из схемы параметров и описания, добавить `minAvgViews` (обязателен)
  и `minEngagementRate` (опционален, дефолт `0.1`), обновить проброс в `runSimilarDiscovery`.
