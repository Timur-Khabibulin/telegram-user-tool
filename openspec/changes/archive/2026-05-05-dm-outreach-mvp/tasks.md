## 1. Расширить telegram_get_messages

- [x] 1.1 В маппинге `telegram_get_messages` (src/index.ts) добавить поле `userAccessHash`: если `m.sender instanceof Api.User && m.sender.accessHash != null && !m.sender.min` — добавить `userAccessHash: m.sender.accessHash.toString()` в возвращаемый объект сообщения

## 2. Новый инструмент telegram_send_dm

- [x] 2.1 Добавить в src/index.ts инструмент `telegram_send_dm` с параметрами `userId: string`, `accessHash: string`, `text: string`
- [x] 2.2 Конструировать `InputPeerUser` явно: `new Api.InputPeerUser({ userId: BigInt(userId), accessHash: BigInt(accessHash) })`
- [x] 2.3 Обработать ошибку `USER_PRIVACY_RESTRICTED` → `{ error: 'privacy_blocked' }`
- [x] 2.4 Обработать ошибку `USER_DEACTIVATED` → `{ error: 'deactivated' }`
- [x] 2.5 Обработать `FLOOD_WAIT_X`: ждать X секунд, одна повторная попытка; при повторном `FLOOD_WAIT` → `{ error: 'flood_wait' }`
- [x] 2.6 При успехе возвращать `{ ok: true, messageId: result.id }`

## 3. Новый инструмент telegram_get_dm_replies

- [x] 3.1 Добавить в src/index.ts инструмент `telegram_get_dm_replies` с параметром `entries: Array<{ userId: string, userAccessHash: string, lastAgentMsgAt: number }>`
- [x] 3.2 Для каждого entry конструировать `InputPeerUser` из `userId` + `userAccessHash`
- [x] 3.3 Вызывать `client.getMessages(peer, { limit: 20 })` и фильтровать: только сообщения от пользователя (не от агента) с `date > lastAgentMsgAt`
- [x] 3.4 Возвращать результат в формате, аналогичном `telegram_get_messages`: `{ userId, messages: [{ id, text, date }] }`

## 4. DB-инструменты: таблица dm_candidates

- [x] 4.1 В src/channels-db.ts добавить функцию `ensureDmCandidatesTable(db)` — `CREATE TABLE IF NOT EXISTS dm_candidates (...)` + индексы (вызывать внутри каждого write-инструмента)
- [x] 4.2 Реализовать `dm_candidates_insert(agentId, record)` — INSERT OR IGNORE по `(sourceChatId, msgId)`
- [x] 4.3 Реализовать `dm_candidates_get_pending(agentId, limit)` — SELECT WHERE status='pending' ORDER BY score DESC LIMIT limit
- [x] 4.4 Реализовать `dm_candidates_update_status(agentId, id, status)` — UPDATE по id
- [x] 4.5 Реализовать `dm_candidates_expire_old(agentId, olderThanDays)` — UPDATE status='expired' WHERE status='pending' AND createdAt < now - olderThanDays*86400

## 5. DB-инструменты: таблица dm_history

- [x] 5.1 В src/channels-db.ts добавить функцию `ensureDmHistoryTable(db)` — `CREATE TABLE IF NOT EXISTS dm_history (...)` + индекс (вызывать внутри каждого write-инструмента)
- [x] 5.2 Реализовать `dm_history_check_cooldown(agentId, userId)` — возвращает `true` если нет записей с `sentAt > now - 7*86400`
- [x] 5.3 Реализовать `dm_history_count_today(agentId)` — COUNT(*) WHERE sentAt > полночь UTC (unix timestamp начала текущих суток UTC)
- [x] 5.4 Реализовать `dm_history_insert(agentId, record)` — INSERT с полями: `userId`, `userAccessHash`, `username`, `triggerText`, `dmText`, `sentAt`, `lastAgentMsgAt`, `replyCount`, `status`
- [x] 5.5 Реализовать `dm_history_get_active(agentId)` — SELECT WHERE status IN ('sent','in_dialogue'), возвращает все поля включая `userAccessHash`
- [x] 5.6 Реализовать `dm_history_update(agentId, id, fields)` — UPDATE по id, поля: `status`, `replyCount`, `lastAgentMsgAt`, `username`

## 6. Обновить существующий скилл telegram-group-monitor

- [x] 6.1 В skills/telegram-group-monitor/SKILL.md добавить шаг 5.8 (после `tg_channels_mark_processed`): оценка интересных сообщений для DM
- [x] 6.2 Описать критерии оценки (0.9–1.0 / 0.6–0.8 / ниже 0.6) и условие записи: `score >= 0.6` → `dm_candidates_insert` с полями `userId`, `userAccessHash`, `sourceChatId`, `msgId`, `msgText`, `score`, `scoreReason`
- [x] 6.3 Обновить таблицу инструментов в конце SKILL.md: добавить `dm_candidates_insert`

## 7. Написать скилл dm-send

- [x] 7.1 Создать файл skills/dm-send/SKILL.md
- [x] 7.2 Описать шаг 0: проверка дневного лимита через `dm_history_count_today`; если ≥ 15 — перейти к уведомлению
- [x] 7.3 Описать шаги 1–2: `dm_candidates_expire_old(3)`, `dm_candidates_get_pending(100)`
- [x] 7.4 Описать шаг 3: цикл проверки cooldown по каждому кандидату
- [x] 7.5 Описать шаг 4: LLM выбирает топ 10–15 (score, не более 2–3 из одного sourceChatId)
- [x] 7.6 Описать шаг 5: для каждого выбранного — формулировка DM, вызов `telegram_send_dm`, обработка результатов (`sent` / `privacy_blocked` / `deactivated`), пауза 30–60с
- [x] 7.7 Описать шаг 6: итоговое уведомление в Saved Messages (отправлено / пропущено / ошибок / осталось в очереди)

## 8. Написать скилл dm-replies

- [x] 8.1 Создать файл skills/dm-replies/SKILL.md
- [x] 8.2 Описать шаг 0: проверка времени UTC+5; вне 08:00–01:00 — завершить
- [x] 8.3 Описать шаги 1–2: `dm_history_get_active`, `telegram_get_dm_replies(entries)`
- [x] 8.4 Описать шаг 3a: первый ответ пользователя (status=sent) — ответить, status→in_dialogue, replyCount→1
- [x] 8.5 Описать шаг 3b: второй ответ пользователя (status=in_dialogue) — ответить финально, status→done, replyCount→2
- [x] 8.6 Описать шаг 4: 48ч без ответа → status→done
- [x] 8.7 Описать шаг 5: негатив (LLM) → не отвечать, status→done
- [x] 8.8 Описать шаг 6: уведомление в Saved Messages после каждого ответа агента

## 9. Зарегистрировать крон-задачи

- [x] 9.1 Зарегистрировать Cron 2: скилл dm-send, расписание 14:00 UTC+5 (09:00 UTC) ежедневно
- [x] 9.2 Зарегистрировать Cron 3: скилл dm-replies, расписание каждые 30 минут
