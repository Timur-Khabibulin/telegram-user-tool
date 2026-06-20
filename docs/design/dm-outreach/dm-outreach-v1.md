# DM Outreach — MVP Specification

> Историческая аналитика фичи (v1, перенесена из корневого `featureDMOutreachSpec.md`).
> Это исходный разбор на момент проектирования. **Нормативное поведение сейчас —
> в `openspec/specs/`** (`dm-candidates`, `dm-send`, `dm-history`, `dm-replies`);
> при расхождении источник истины — openspec, а не этот документ.

## Контекст

Текущий проект мониторит групповые чаты Telegram и отвечает на сообщения от имени агента с персоной. Цель — привлечение подписчиков в канал.

Новая фича: агент видит сообщение в группе, решает написать автору в личку, ведёт короткий диалог и естественно завершает его.

---

## Гипотезы

**H1.** Персональное обращение в личку конвертирует в подписчика лучше, чем ответ в группе.

**H2.** Люди, с которыми агент поговорил в личке, с большей вероятностью перейдут в канал.

**H3.** Агент может определить по сообщению в группе, кому и когда стоит написать в личку.

MVP проверяет все три гипотезы. Если H1 не подтвердится — вся фича не нужна.

---

## Бизнес-требования

| # | Требование | Метрика успеха |
|---|---|---|
| BR-1 | Агент накапливает интересные сообщения из групп в очередь кандидатов | Очередь стабильно пополняется ежедневно |
| BR-2 | Из очереди ежедневно выбираются лучшие кандидаты и им отправляются DM | 10-15 DM в день, без банов |
| BR-3 | DM-коммуникация увеличивает конверсию в подписчика канала | Конверсия DM → подписка > конверсии из ответов в группе |
| BR-4 | Агент не вызывает жалоб и не получает блокировки | 0 банов аккаунта за период MVP |
| BR-5 | Одному пользователю агент пишет не чаще одного раза в 7 дней | Нет повторных жалоб от одного человека |

---

## Scope MVP

### Входит

- Скилл мониторинга групп (Cron 1, существующий) дополнительно записывает интересные сообщения в таблицу `dm_candidates`
- Отдельный ежедневный скилл (Cron 2) читает `dm_candidates`, выбирает лучшие через LLM, отправляет DM с паузой 30-60 сек между сообщениями
- Cooldown: не писать одному пользователю чаще, чем раз в 7 дней
- Отдельный скилл (Cron 3) читает входящие DM, отвечает — работает только с 08:00 до 01:00 по UTC+5
- Агент ведёт диалог максимум 2 обмена после первого DM, потом завершает
- Уведомление в Saved Messages об итогах ежедневной рассылки (Cron 2)

### Не входит

- Диалог длиннее 2 обменов после первого DM
- Автоматическое отслеживание перехода в канал
- Аналитика и дашборды
- A/B тесты формулировок
- Ручная модерация очереди кандидатов

---

## Архитектура

Три независимых кронджоба:

```
Cron 1 (каждые 3ч) — skills/telegram-group-monitor/SKILL.md       [существующий, доработка]
  → читает группы
  → отвечает в группах
  → оценивает интересные сообщения
  → записывает кандидатов в dm_candidates

Cron 2 (раз в день, 14:00 UTC+5) — skills/dm-send/SKILL.md        [новый]
  → чистит dm_candidates (pending старше 3 дней → expired)
  → читает dm_candidates (status='pending')
  → проверяет cooldown по dm_history
  → LLM выбирает топ 10-15 из очереди
  → отправляет DM с паузой 30-60 сек между каждым
  → пишет результат в dm_history
  → помечает кандидатов как sent/skipped
  → итоговое уведомление в Saved Messages

Cron 3 (каждые 30мин, 08:00–01:00 UTC+5) — skills/dm-replies/SKILL.md  [новый]
  → проверяет текущее время, выходит если вне диапазона
  → читает dm_history (status IN ('sent', 'in_dialogue'))
  → для каждой записи читает сообщения пользователя новее lastAgentMsgAt
  → если есть новые сообщения → отвечает, обновляет статус
  → закрывает диалоги без ответа более 48ч
```

---

## Функциональные требования

### FR-1. Таблица dm_candidates

**Назначение:** очередь сообщений из групповых чатов, авторам которых потенциально стоит написать в личку. Заполняется Cron 1 при каждом обходе групп. Cron 2 читает её раз в день, выбирает лучших кандидатов и после отправки DM переводит записи в финальный статус.

```sql
CREATE TABLE IF NOT EXISTS dm_candidates (
                                             id             INTEGER PRIMARY KEY AUTOINCREMENT,
                                             userId         TEXT NOT NULL,          -- Telegram userId автора сообщения
                                             userAccessHash TEXT,                   -- access_hash для InputPeerUser; сохраняется при записи,
    -- чтобы Cron 2 не зависел от in-memory кэша Cron 1
                                             sourceChatId   TEXT NOT NULL,          -- id группового чата, откуда взято сообщение
                                             msgId          INTEGER NOT NULL,       -- id сообщения в чате
                                             msgText        TEXT NOT NULL,          -- текст сообщения; используется агентом при формулировке DM
                                             score          REAL DEFAULT 0,         -- оценка LLM от 0.0 до 1.0
                                             scoreReason    TEXT,                   -- краткое обоснование оценки
                                             status         TEXT DEFAULT 'pending', -- статус обработки (см. ниже)
                                             createdAt      INTEGER NOT NULL        -- unix timestamp добавления в таблицу
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_candidates_msg
    ON dm_candidates (sourceChatId, msgId);

CREATE INDEX IF NOT EXISTS idx_dm_candidates_status
    ON dm_candidates (status, score DESC);
```

**Статусы `dm_candidates.status`:**

| Статус | Значение |
|---|---|
| `pending` | Кандидат добавлен, ещё не обработан Cron 2 |
| `sent` | DM успешно отправлен |
| `skipped` | Кандидат пропущен: активный cooldown, закрытые настройки приватности или деактивированный аккаунт |
| `expired` | Запись находилась в статусе `pending` более 3 дней и выведена из активной очереди |

Инструменты в `channels-db.ts`:

- `dm_candidates_insert(agentId, record)` → вставляет кандидата, игнорирует дубли (ON CONFLICT IGNORE по `sourceChatId, msgId`)
- `dm_candidates_get_pending(agentId, limit)` → возвращает кандидатов со статусом `pending`, сортировка по `score DESC`
- `dm_candidates_update_status(agentId, id, status)` → обновляет статус
- `dm_candidates_expire_old(agentId, olderThanDays)` → переводит в `expired` только записи со статусом `pending`, где `createdAt < now - olderThanDays * 86400`

---

### FR-2. Таблица dm_history

**Назначение:** каждая запись описывает один диалог — от момента отправки первого DM до завершения. Один пользователь может иметь несколько записей, если с ним общались в разное время. Cron 2 проверяет cooldown перед отправкой нового DM; Cron 3 читает активные диалоги, определяет непрочитанные сообщения и обновляет состояние после каждого ответа агента.

Правило "не писать чаще раза в 7 дней" обеспечивается логикой `dm_history_check_cooldown` — ограничений уникальности на уровне таблицы нет.

```sql
CREATE TABLE IF NOT EXISTS dm_history (
                                          id              INTEGER PRIMARY KEY AUTOINCREMENT,
                                          userId          TEXT NOT NULL,      -- Telegram userId получателя
                                          userAccessHash  TEXT NOT NULL,      -- access_hash для конструирования InputPeerUser на месте вызова
                                          username        TEXT,               -- @username, если известен; используется в уведомлениях
                                          triggerText     TEXT NOT NULL,      -- текст сообщения в группе, которое спровоцировало DM;
    -- используется Cron 3 как контекст при генерации ответов
                                          dmText          TEXT NOT NULL,      -- текст первого DM, отправленного агентом
                                          sentAt          INTEGER NOT NULL,   -- unix timestamp отправки первого DM
                                          lastAgentMsgAt  INTEGER NOT NULL,   -- unix timestamp последнего сообщения агента в диалоге;
    -- используется как курсор: сообщения пользователя
    -- новее этого значения считаются непрочитанными
                                          replyCount      INTEGER DEFAULT 0,  -- количество ответов агента после первого DM (не считая его)
                                          status          TEXT DEFAULT 'sent' -- статус диалога (см. ниже)
);

CREATE INDEX IF NOT EXISTS idx_dm_history_user_sent
    ON dm_history (userId, sentAt DESC);
```

**Статусы `dm_history.status`:**

| Статус | Значение |
|---|---|
| `sent` | Первый DM отправлен, ответа от пользователя ещё не было |
| `in_dialogue` | Пользователь ответил хотя бы раз, диалог активен |
| `done` | Диалог завершён: агент отправил финальную фразу, или истёк таймаут 48ч без ответа пользователя, или обнаружен негатив |
| `privacy_blocked` | Первый DM не был доставлен из-за настроек приватности пользователя |

Статусы `sent` и `in_dialogue` — активные: Cron 3 проверяет по ним новые сообщения. Статусы `done` и `privacy_blocked` — финальные: Cron 3 их игнорирует.

Инструменты в `channels-db.ts`:

- `dm_history_check_cooldown(agentId, userId)` → `boolean` (true = можно писать; false = есть запись с `sentAt > now - 7 days`)
- `dm_history_insert(agentId, record)` → вставляет запись
- `dm_history_get_active(agentId)` → записи где `status IN ('sent', 'in_dialogue')`
- `dm_history_update(agentId, id, fields)` → обновляет поля записи

---

### FR-3. Инструмент отправки DM

Новый инструмент в плагине `telegram-user-tools`:

```typescript
telegram_send_dm(userId: string, accessHash: string, text: string)
```

- Принимает `accessHash` явным параметром (берётся из `dm_candidates.userAccessHash`)
- Конструирует `InputPeerUser` на месте, не зависит от `userPeerCache`
- Возвращает `{ ok: true, messageId }` или `{ error: string }`
- Лимит: не более 15 DM в сутки на аккаунт (счётчик сбрасывается в полночь UTC)

Обработка ошибок:

| Ошибка | Действие |
|---|---|
| `USER_PRIVACY_RESTRICTED` | вернуть `{ error: 'privacy_blocked' }` |
| `FLOOD_WAIT_X` | ждать X секунд, одна повторная попытка |
| `USER_DEACTIVATED` | вернуть `{ error: 'deactivated' }` |
| Дневной лимит исчерпан | вернуть `{ error: 'daily_limit_reached' }` |

---

### FR-4. Источник access_hash

`accessHash` сохраняется в `dm_candidates` в момент записи кандидата (Cron 1). Источник — поле `m.sender.accessHash` из `telegram_get_messages`. Необходимо расширить возвращаемый объект сообщения:

```typescript
// При маппинге сообщений в telegram_get_messages
if (m.sender instanceof Api.User && m.sender.accessHash != null && !m.sender.min) {
    // Добавить в возвращаемый объект:
    userAccessHash: m.sender.accessHash.toString()
}
```

Оба крона работают одинаково: читают `userId` и `userAccessHash` из своей таблицы (`dm_candidates` для Cron 2, `dm_history` для Cron 3) и конструируют `InputPeerUser` непосредственно перед вызовом:

```typescript
new Api.InputPeerUser({
    userId: BigInt(userId),
    accessHash: BigInt(userAccessHash),
})
```

Зависимости от `userPeerCache` или `client.getEntity` нет.

---

### FR-5. Инструмент чтения входящих DM

```typescript
telegram_get_dm_replies(entries: Array<{ userId: string, userAccessHash: string, lastAgentMsgAt: number }>)
```

- Принимает массив объектов из `dm_history_get_active`
- Для каждого конструирует `InputPeerUser` из `userId` и `userAccessHash`
- Вызывает `client.getMessages(peer, { limit: 20 })`
- Возвращает только сообщения **от пользователя** (не от агента) с `date > lastAgentMsgAt`
- Формат возврата аналогичен `telegram_get_messages`

Использование `lastAgentMsgAt` как курсора гарантирует, что каждый запуск Cron 3 видит только сообщения, пришедшие после последнего ответа агента — не раньше и не повторно.

---

### FR-6. Скилл skills/telegram-group-monitor/SKILL.md — этап записи кандидатов

Доработка существующего скилла. В конце обработки каждой группы добавляется этап:

```
После обработки сообщений группы:

Для каждого сообщения, которое ты счёл интересным:
1. Оцени потенциал для DM по шкале 0.0–1.0:
   - 0.9–1.0: сильный личный вопрос, экспертиза, живой интерес к теме канала
   - 0.6–0.8: есть зацепка, но повод для DM не очевиден
   - ниже 0.6: пропустить

2. Если score >= 0.6:
   - Запиши в dm_candidates через dm_candidates_insert:
     userId, userAccessHash, sourceChatId, msgId, msgText, score, scoreReason
   - НЕ отправляй DM прямо сейчас
```

---

### FR-7. Скилл skills/dm-send/SKILL.md

Новый скилл. Запускается раз в день в 10:00 UTC+5.

**Цель:** ежедневно отбирать лучших кандидатов из очереди `dm_candidates` и отправлять им персональные DM от имени агента.

**Предусловия:** таблицы `dm_candidates` и `dm_history` существуют в БД агента; аккаунт загружен через `tg_load_account`.

**Стратегия идемпотентности:** повторный запуск безопасен — кандидаты со статусами `sent`/`skipped` уже не попадут в выборку; cooldown в `dm_history` предотвращает двойную отправку одному пользователю.

**Ограничения:** лимит 15 DM/день (проверяется через `dm_history_count_today` в самом начале); пауза 30–60с между отправками; при `FLOOD_WAIT` — немедленно остановить рассылку и перейти к итоговому уведомлению.

**Основной алгоритм:**

```
1. Вызови dm_candidates_expire_old(3)
   — переводит в 'expired' только pending-записи старше 3 дней

2. Вызови dm_candidates_get_pending(limit=100) — получи очередь

3. Для каждого кандидата:
   - Вызови dm_history_check_cooldown(userId)
   - Если cooldown активен → dm_candidates_update_status(id, 'skipped'), пропусти

4. Из оставшихся кандидатов выбери топ 10-15:
   - Учитывай score
   - Не более 2-3 кандидатов из одного sourceChatId
   - При равном score предпочитай более свежие записи (больший createdAt)

5. Для каждого выбранного:
   - Сформулируй текст DM: короткий, естественный, без рекламы,
     основан на конкретном сообщении человека (msgText)
   - Вызови telegram_send_dm(userId, userAccessHash, dmText)

   - При успехе:
     · now = текущий unix timestamp
     · dm_history_insert:
         userId=userId, userAccessHash=userAccessHash, username=null,
         triggerText=msgText, dmText=dmText, sentAt=now,
         lastAgentMsgAt=now, replyCount=0, status='sent'
     · dm_candidates_update_status(id, 'sent')

   - При ошибке 'privacy_blocked':
     · dm_history_insert:
         userId=userId, userAccessHash=userAccessHash, username=null,
         triggerText=msgText, dmText=dmText, sentAt=now,
         lastAgentMsgAt=now, replyCount=0, status='privacy_blocked'
     · dm_candidates_update_status(id, 'skipped')

   - При ошибке 'deactivated':
     · dm_candidates_update_status(id, 'skipped')

   - При ошибке 'daily_limit_reached':
     · остановить отправку, перейти к шагу 6

   - Подожди случайное время от 30 до 60 секунд перед следующей отправкой

6. Отправь итоговое уведомление в Saved Messages (см. FR-9)
```

---

### FR-8. Скилл skills/dm-replies/SKILL.md

Новый скилл. Запускается каждые 30 минут.

**Цель:** обрабатывать входящие личные сообщения от пользователей, которым агент написал DM, и вести диалог не более 2 обменов до естественного завершения.

**Предусловия:** таблица `dm_history` существует и содержит записи с активными статусами (`sent`, `in_dialogue`); аккаунт загружен через `tg_load_account`.

**Стратегия идемпотентности:** курсор `lastAgentMsgAt` гарантирует, что каждый запуск видит только сообщения, пришедшие после последнего ответа агента — повторная обработка одного сообщения невозможна.

**Ограничения:** работает только с 08:00 до 01:00 UTC+5 (вне диапазона — немедленный выход без действий); максимум 2 ответа агента после первого DM; негатив в сообщении пользователя — закрыть диалог без ответа.

**Основной алгоритм:**

```
0. Проверь текущее время UTC+5:
   - Если время вне диапазона 08:00–01:00 → завершить работу

1. Вызови dm_history_get_active
   — возвращает записи со status IN ('sent', 'in_dialogue')
   — каждая запись содержит: id, userId, userAccessHash, username, triggerText, dmText, lastAgentMsgAt, replyCount

2. Вызови telegram_get_dm_replies(entries)
   — возвращает для каждого userId сообщения с date > lastAgentMsgAt

3. Для каждого userId с новыми сообщениями:

   Сформируй контекст для генерации ответа:
   - triggerText: исходное сообщение пользователя в группе
   - dmText: первый DM агента
   - новые сообщения пользователя

   a. status = 'sent' (replyCount = 0):
      - Это первый ответ пользователя
      - Ответь естественно: поблагодари или продолжи тему
      - Упомяни канал только если органично и уместно
      - dm_history_update: status='in_dialogue', replyCount=1, lastAgentMsgAt=now

   b. status = 'in_dialogue' (replyCount = 1):
      - Это второй ответ пользователя
      - Ответь кратко и естественно завершай диалог
      - dm_history_update: status='done', replyCount=2, lastAgentMsgAt=now

4. Для каждой активной записи без новых сообщений:
   - Если now - lastAgentMsgAt > 48ч → dm_history_update: status='done'
   — агент ждал ответа 48 часов, диалог закрывается без лишних действий

5. Если любое из новых сообщений пользователя содержит негатив (оценка LLM):
   - Не отвечать
   - dm_history_update: status='done'
```

---

### FR-9. Уведомление в Saved Messages

Итоговый отчёт Cron 2 после отправки:
```
📤 DM-рассылка завершена
Отправлено: 12 / Пропущено (cooldown): 8 / Ошибок: 2
Кандидатов в очереди осталось: 34
```

---

## Технические ограничения и риски

| Риск | Митигация |
|---|---|
| Бан за спам в личку | Лимит 15 DM/день, пауза 30-60с между отправками, cooldown 7 дней |
| `USER_PRIVACY_RESTRICTED` у большинства | Считать % записей со статусом `privacy_blocked`; если >50% — фича нерентабельна |
| access_hash для Cron 2 протухает | Сохранять в `dm_candidates` при записи — Cron 2 не зависит от памяти Cron 1 |
| Очередь растёт быстрее расхода | `expire_old` чистит только `pending` старше 3 дней ежедневно |
| Агент не завершает диалог | Жёсткая логика по `replyCount` и `status` в скилле, не только в промпте |
| Конфликт gramjs-сессий между тремя кронами | `--session isolated` на каждом; одна StringSession — проверить на реальных данных |

---

## Критерий успеха MVP

Через 2-4 недели после запуска:

- Конверсия DM → подписка заметно выше, чем ответ в группе → H1 подтверждена
- Записей со статусом `privacy_blocked` < 50% от всех попыток → аудитория доступна для DM
- 0 банов, 0 жалоб → риски управляемы
- Очередь `dm_candidates` стабильно пополняется → H3 подтверждена

---

## План разработки

1. Расширить `telegram_get_messages` — добавить `userAccessHash` в возвращаемый объект сообщения
2. Написать `telegram_send_dm(userId, accessHash, text)` с обработкой ошибок и дневным счётчиком
3. Написать `telegram_get_dm_replies(entries)` с курсором по `lastAgentMsgAt`
4. Создать таблицы `dm_candidates` и `dm_history` + 8 инструментов в `channels-db.ts`
5. Обновить `skills/telegram-group-monitor/SKILL.md` — добавить этап оценки и записи кандидатов
6. Написать `skills/dm-send/SKILL.md`
7. Написать `skills/dm-replies/SKILL.md`
8. Зарегистрировать Cron 2 (раз в день, 10:00 UTC+5) и Cron 3 (каждые 30 мин)
9. Запустить с лимитом 10 DM/день и ручным мониторингом уведомлений
10. 