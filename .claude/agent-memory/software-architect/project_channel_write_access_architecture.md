---
name: project-channel-write-access-architecture
description: Находки при проектировании channel-write-access (право писать в канал) — непроизводные решения, где реюз кода снимает целые куски работы
metadata:
  type: project
---

Фича «Право писать в канал». Требования — `docs/design/channel-write-access/requirements-v1.md`
(R1..R16). Архитектура написана — `docs/design/channel-write-access/architecture.md`.
Спроектирована, не реализована.

**Непроизводные находки (проверено чтением кода, не выводится дёшево):**

- **Ротацию менять НЕ нужно.** `channel-rotation` читает только `leaved_from_banned`.
  Гейт «постоянная → read-only / переменная → ротировать» (R8/R9/R10) целиком
  обеспечивается ОДНИМ дискриминатором выше по потоку: ставим ли `status='banned'`.
  Переменная → `banned` → существующий leave→leaved_from_banned→rotate. Постоянная →
  `status` не трогаем. `plan.ts`/`run.ts`/`leave-banned-channels`/`getLeaveQueue` — без правок.

- **`chatId` в `channels.db` = id ГРУППЫ ОБСУЖДЕНИЯ** (join кладёт `discussionChat`), не
  broadcast-канала. Поэтому и `default_banned_rights`, и живой `GetParticipant`
  относятся к строке `channels` напрямую — R2 («проверять в группе обсуждения»)
  соблюдается самой моделью данных, без нового резолва. `chatAccessHash` уже в строке.

- **Постоянная величина снимается БЕЗ доп. вызова.** `service.joinDiscussionGroups` уже
  держит `discussionChat: Api.Channel` и `fullChannel` в области видимости —
  `discussionChat.defaultBannedRights.sendMessages` берётся из уже сделанного
  `GetFullChannel`. Проброс через новое поле в `JoinedChannelIdentity` →
  `upsertChannelIdentityFromJoin` (который и так делает полный сброс status при self-heal).

- **`no_discussion` не имеет строки `channels`.** Broadcast без группы обсуждения join
  возвращает `skipped`, `join-queue` ставит `status='error'`, `upsertChannelIdentityFromJoin`
  не зовётся. «Read-only» для него физически не к чему привязать (агент не член группы).
  Развилка на владельце: A — признак живёт на `join_queue` (рекоменд.), B — заводить
  строку channels/вступать в broadcast (скоуп-расширение). Меняет трактовку AC-2.

- **`GetParticipant(InputPeerSelf)` уже есть как DEBUG-заглушка** `debugCheckAdmin`
  (service.ts ~1572) — заменяется нормальным методом с дискриминированным исходом
  (`USER_NOT_PARTICIPANT` приходит ОШИБКОЙ, не объектом участника).

- **Репойнт `allow_payment_required`:** сейчас monitor-v2 ставит на него `format_error`;
  по §3 требований это причина `paid` (постоянная, read-only) — ветка format_error для
  него убирается. `chat_send_plain/media_forbidden` в перечень §3 НЕ входят — оставить
  вне скоупа.

**Модель данных:** одна причина `write_access_reason` (NULL=можно/непроверено) +
`write_access_source` (join|precheck|send_error, кодирует момент+сигнал для R7) +
`write_access_until` (справочно, R11). Тип постоянная/переменная НЕ хранится —
`isPermanentReason(r)` чистая функция. Классификация — новый чистый модуль
`src/core/write-access.ts`.

**Развилки закрыты владельцем** (§8 architecture.md): checked_at-колонка НЕ добавляется
(модель = reason+until); no_discussion — вариант A (строку channels НЕ заводим, пометка
на join_queue, AC-2 = фиксация на уровне очереди); GetParticipant — раз на канал за
прогон (не на сообщение); plain/media-forbidden остаются format_error; снятие причины —
только в precheck (без дубля после отправки).

**R17 (уточнение владельца, аналитик заводит в ТЗ):** один прогон — одна попытка на канал.
Уже обеспечено потоком monitor-v2 без нового кода: проактивно precheck пропускает фазу
отправок канала (continue), реактивно первая не-flood ошибка бросает существующий
`ChannelSkipError` → внешний catch помечает канал обработанным и continue (циклы
5.4/5.5/5.6 прерываются). **Также ранее убрана колонка `write_access_source`** — R7
отменён в части хранения источника/момента, осталась только классификация причины.

**Реализация перенесена v2→v5 (2026-09-19):** monitor-v2 МЁРТВ (enabled=0 у 137 агентов),
живой монитор — monitor-v5 (enabled=1 у 46). Первая реализация ошибочно легла в monitor-v2
— откачена; интеграция теперь в monitor-v5. Ключевое структурное отличие v5: у него НЕТ
инлайн-классификации ошибок отправки (как у v2) — sendReply делегирует в общий
`core/post-comment-send.ts` `handlePostCommentSendError`, который зовут также
monitor-v3/v4/review-listener. Реактивная запись причины + репойнт `paid` живут ТАМ →
действуют на всех пост-комментных отправителей (инертно для v3/v4: precheck-гейт только у
v5, потребитель причины — getChannelsBatch/precheck). Проактивный precheck — шаг 5.3c
monitor-v5 (после classifyMessages, до фазы отправок), гейт циклов через
`canWrite ? [...] : []`, сбор DM остаётся независимым (R8). Метод `getSelfParticipant` в
service.ts уже есть. Тест write-access.test.ts зелёный (16/16), `openspec validate
channel-write-access` — valid. Дельта способности переименована group-monitoring-v2 →
group-monitoring-v5 (обе способности реально есть в openspec/specs/).

Связано: [[feedback-verify-live-component-before-designing]] (урок из этого промаха),
[[project-channel-multipersona-architecture]] (ротация/реестр — этот design
опирается на текущий leaved_from_banned-механизм, ДО multipersona-рефактора),
[[feedback-dont-override-requirements-from-code-inference]] (перечень причин §3 —
нормативный, не срезать по коду).
