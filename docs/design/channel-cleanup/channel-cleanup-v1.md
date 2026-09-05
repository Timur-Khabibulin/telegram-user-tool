# Design Doc: channel-cleanup v1

## 1. Описание фичи

Ручной OpenClaw-инструмент для очистки слабых каналов у выбранных агентов: агент выходит из канала и все рабочие данные агента по нему удаляются из всех БД. Запускается оператором вручную, не по расписанию.

**Критерий отбора — AND-логика**: канал чистится только если выполнены ВСЕ переданные условия. NULL-значения в обоих полях (`avg_views`, `subs_count`) считаются нулём.

---

## 2. Параметры инструмента

| Параметр | Тип | Обязательный | Описание |
|---|---|---|---|
| `agents` | `string[]` | Да | Список agentId, у которых выполнять чистку |
| `minSubsCount` | `number` | Нет | Чистить, если `subs_count < N` (NULL = 0) |
| `minAvgViews` | `number` | Нет | Чистить, если `avg_views < N` (NULL = 0) |

**Валидация:** хотя бы один из `minSubsCount` или `minAvgViews` обязателен. Иначе — ошибка до начала работы.

---

## 3. Схема данных: что меняется в БД

### 3.1. tg-channels.db (per-agent) — таблица `channels`

Два изменения в рамках **Задачи A**:

**A1. Переименовать** `avg_views_updated_at` → `coverage_updated_at`

`avg_views` и `subs_count` обновляются одновременно скриптом `channel-coverage-update.ts` — одно поле времени достаточно. Используется `ALTER TABLE channels RENAME COLUMN avg_views_updated_at TO coverage_updated_at` (SQLite 3.25+).

**A2. Добавить** `subs_count INTEGER` — аддитивная миграция через `ALTER TABLE ADD COLUMN`.

Итоговая схема релевантных полей:

```sql
channels (
    chatId              TEXT    PRIMARY KEY,
    title               TEXT    NOT NULL,
    lastProcessedAt     INTEGER NOT NULL DEFAULT 0,
    channelId           TEXT,
    channelAccessHash   TEXT,
    channelUsername     TEXT,            -- ключ для discovery.db (best-effort)
    channelResolved     INTEGER NOT NULL DEFAULT 0,
    avg_views           REAL,            -- NULL = не считался
    subs_count          INTEGER,         -- NULL = не считался
    coverage_updated_at INTEGER          -- NULL = ни разу не обновлялся
);
```

### 3.2. discovery.db (глобальная, adminAgentId)

Таблица `discovered_channels` — при чистке канала строка удаляется (DELETE), не помечается. Best-effort: только если `channelUsername IS NOT NULL`.

---

## 4. Алгоритм скилла

```
для каждого agentId из agents:

  1. tg.loadAccount(agentId)
     - если ошибка → предупреждение в лог, перейти к следующему агенту

  2. Загрузить все каналы агента:
     SELECT chatId, title, avg_views, subs_count, channelUsername, channelResolved
     FROM channels

  3. Отбор кандидатов (AND по активным условиям):
     для каждого канала:
       если minAvgViews задан:
         effectiveViews = avg_views ?? 0
         если effectiveViews >= minAvgViews → пропустить
       если minSubsCount задан:
         effectiveSubs = subs_count ?? 0
         если effectiveSubs >= minSubsCount → пропустить
       → канал-кандидат

  4. tg.populatePeerCacheForIds(candidates.chatIds)
     — итерирует ВСЕ диалоги TG без лимита страниц до тех пор,
       пока все chatId кандидатов не найдены или диалоги не закончились.
     - если ошибка → предупреждение в лог, перейти к следующему агенту

  5. для каждого кандидата:
     a. leaveChannel(chatId)
        - если ошибка → leaveFailed++, пропустить шаги b и c, перейти к следующему каналу
     b. purgeChannelData(agentId, chatId)
     c. Удалить из discovered_channels (best-effort):
        - если channelResolved = 1 AND channelUsername IS NOT NULL:
            canonical = normalizeChannelLink(channelUsername)
            deleteDiscoveredChannel(FUNNEL_ADMIN_AGENT_ID, canonical)
        - иначе: discoverySkipped++
     d. cleaned++

После обхода всех агентов:
  6. Один общий отчёт: tg.sendSavedMessage(reportText) от первого успешно
     загруженного агента — в его Saved Messages.

Вернуть итог по всем агентам
```

---

## 5. Что удаляется из каких таблиц

| БД | Таблица | Действие | Условие |
|---|---|---|---|
| tg-channels.db | `channels` | DELETE WHERE chatId = ? | всегда |
| tg-channels.db | `channel_visits` | DELETE WHERE chatId = ? | всегда |
| tg-channels.db | `dm_candidates` | DELETE WHERE sourceChatId = ? | всегда |
| tg-replies.db | `replies` | DELETE (через `purgeChannelThreads`) | всегда |
| tg-replies.db | `group_threads` | DELETE (через `purgeChannelThreads`) | всегда |
| tg-replies.db | `group_thread_agent_msgs` | DELETE (через `purgeChannelThreads`) | всегда |
| discovery.db | `discovered_channels` | DELETE WHERE canonical_link = ? | только если channelResolved=1 И channelUsername IS NOT NULL |
| tg-channels.db | `send_errors` | НЕ трогать | история для отчётов |
| tg-channels.db | `dm_threads` | НЕ трогать | личные диалоги — другой peer |
| tg-join-queue.db | `join_queue` | НЕ трогать | v1 |

---

## 6. Уведомление в Saved Messages

Один общий отчёт в конце прогона — отправляется от первого успешно загруженного агента в его Saved Messages.

**Формат:**

```
[channel-cleanup] итог
Агентов: 5 | Кандидатов: 120 | Очищено: 98 | Ошибок выхода: 22
Пропущено агентов: agent3, agent7
```

Строка «Пропущено агентов» выводится только если есть пропущенные агенты.

---

## 7. Формат ответа инструмента

```ts
{
  agents: Array<{
    agentId: string;
    candidates: number;        // каналов-кандидатов
    cleaned: number;           // успешно очищено
    leaveFailed: number;       // leaveChannel вернул ошибку
    discoverySkipped: number;  // нет channelUsername → discovery не тронут
    channelList: Array<{
      chatId: string;
      title: string;
      avgViews: number | null;
      subsCount: number | null;
      result: "cleaned" | "leave_failed";
    }>;
  }>;
}
```

---

## 8. Риски

| Риск | Вероятность | Митигация |
|---|---|---|
| `subs_count` / `avg_views` устарели (обновляются раз в месяц) | Высокая | Документировать: перед чисткой рекомендуется запустить `channel-coverage-update` |
| `leaveChannel` не удался (агент уже не участник, канал удалён в TG) | Низкая | Пропустить — `leaveFailed++`; данные не чистить; продолжить |
| `channelUsername = NULL` → строка не удалена из discovery.db | Средняя | Принято: best-effort. Канал может попасть в discovery повторно и быть переназначен |
| NULL значения → удаление «неизученных» каналов | Средняя | Поведение явно задокументировано (NULL = 0); ответственность на операторе |
| После чистки агент снова вступает в тот же канал через discovery | Средняя | Строка в discovery.db удаляется → канал незнаком системе, может быть переоткрыт |

---

## 9. Scope задач

### Задача A — Кеш `subs_count` + рефактор `coverage_updated_at`

Предпосылка для Задачи B. Файлы: `src/core/db/channels.ts`, `src/scripts/channel-coverage-update.ts`.

**Изменения в `channels.ts`:**
- `migrateAvgViewsColumns` → `migrateCoverageColumns`: RENAME COLUMN + ADD COLUMN `subs_count`
- `saveAvgViews(agentId, chatId, avgViews)` → `saveCoverage(agentId, chatId, avgViews, subsCount)`: обновляет оба поля + `coverage_updated_at`
- `getChannelsForAvgUpdate` → `getChannelsForCoverageUpdate`: фильтр по `coverage_updated_at`
- `CoverageChannelRow` + `getAllChannelsWithAvgViews`: добавить `subs_count`

**Изменения в `channel-coverage-update.ts`:**
- После расчёта `avg_views` добавить вызов `tg.getChannelSubsCount(inputChannel)` — возвращает `participantsCount`
- Передавать оба значения в `saveCoverage`
- Обработка FLOOD_WAIT: задержка 500 мс между вызовами, ретрай при `FloodWaitError`, пропуск при повторной ошибке

### Задача B — Скилл `channel-cleanup` (зависит от A)

**Новые файлы и изменения:**
- `src/skills/channel-cleanup.ts` — реализация скилла по образцу `leave-banned-channels.ts`
- Регистрация в OpenClaw-плагине: параметры `agents`, `minSubsCount`, `minAvgViews`
- `src/core/db/channels.ts`: новая функция `getChannelsForCleanup(agentId)` — SELECT с полями `avg_views`, `subs_count`, `channelUsername`, `channelResolved`
- `src/core/db/discovery.ts`: новая функция `deleteDiscoveredChannel(adminAgentId, canonicalLink)` — DELETE строки

---

## 10. Out of scope (v1)

| Что | Почему отложено |
|---|---|
| Пометка в `join_queue` для блокировки повторного вступления | Нет явной потребности |
| Автозапуск по расписанию | Не запрошено |
| dryRun режим | Не запрошено |
