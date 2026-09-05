# Design Doc: Выход из забаненных каналов — v2 (человекоподобный темп)

> Аналитика фичи для человека. Нормативное поведение (требования + сценарии) —
> в `openspec/changes/leave-banned-human-pacing/`, не здесь. Проблема/контекст
> исходной способности — в [v1](leave-banned-channels-v1.md), здесь описана
> только дельта.

## 1. Что изменилось и зачем

v1 запускался раз в сутки, разгребал очередь без пауз между шагами (мгновенный
`resolve → leave`) и хранил очередь в отдельной таблице `banned_channels`,
дублировавшей факт, уже проставляемый в `channels.status = 'banned'`. Это
узнаваемый машинный паттерн (тот же класс проблемы, что уже решался для
`monitor-v5` в `monitor-v5-human-pacing-batching`) и слишком редкий цикл —
канал с `CHAT_WRITE_FORBIDDEN` мог копить шум до суток.

## 2. Источник очереди

Таблица `banned_channels` убрана. Источник — сам `channels.status`:

```
status = 'banned'        — монитор поймал CHAT_WRITE_FORBIDDEN/USER_BANNED_IN_CHANNEL
                            (monitor-v2, monitor-v4/v5 через handlePostCommentSendError)
status = 'should_leave'  — оператор вручную решил, что канал агенту больше не нужен
                            (кто и как проставляет — вне скоупа этого кода)
```

`leave-banned-channels` читает `SELECT chatId FROM channels WHERE status IN
('banned', 'should_leave') ORDER BY statusUpdatedAt ASC LIMIT 20` — лимит
батча за прогон, раньше очередь читалась целиком без ограничения. После
успешной обработки канала статус сбрасывается в `NULL` (вместо удаления
строки из отдельной таблицы).

`monitor.ts` (v1, не используется ни одним агентом — актуальны `monitor-v4`/
`monitor-v5`) при `CHAT_WRITE_FORBIDDEN` теперь просто логирует ошибку и
пропускает канал, не помечая `status` — раньше полагался только на
`banned_channels`. Если v1 когда-нибудь снова станет активным, для его
каналов потребуется отдельно добавить `markChannelStatus(banned)`.

## 3. Человекоподобный темп

```
resolveChannelUsername(chatId)
  │
  ├─ опционально (~50% на канал): 1-3 батча getMessages(7-15 шт, курсор растёт,
  │  reverse: true) + markAsRead на каждый батч, пауза 3-7с между батчами
  │
  пауза 10-20с (всегда, дополнительно к чтению выше)
  │
leaveChannel(chatId)
purgeChannelData (только dm_candidates — channels/channel_visits/replies/
                   group_threads сохраняются, сужено ещё в telegram-error-handling)
markChannelBanned (реестр, best-effort по username)
сброс channels.status → NULL
  │
пауза 2-7с между каналами
```

Курсор для батчей чтения — та же техника, что в Decision 4
`monitor-v5-human-pacing-batching` (`reverse: true`, `minId` растёт между
вызовами), но с другой целью: не дочитать реальный непрочитанный хвост, а
оставить неповторяющийся, правдоподобный след трафика перед выходом.

## 4. Расписание

Период — 180 минут (3ч), было — раз в сутки (01:00 Asia/Yekaterinburg).
`leave-banned` остаётся в списке задач, которым разрешено тикать в тихие часы
(23:00–03:00) — осознанное решение, не побочный эффект прежнего фиксированного
времени.

## 5. Известные ограничения (принято как есть)

- Нет разделения «временная/постоянная причина отказа» для неудачного
  `leaveChannel` (в отличие от `join_queue`) — канал просто остаётся в
  очереди и ретраится каждые 3ч без предела попыток.
- Пометка реестра (`markChannelBanned`) выполняется безусловно, в том числе
  для `should_leave` — не являющегося фактическим баном канала. Не решено.

Подробности решений и альтернатив — `openspec/changes/leave-banned-human-pacing/design.md`.
