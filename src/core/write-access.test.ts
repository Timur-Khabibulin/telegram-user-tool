// core/write-access.test.ts — юнит-тесты чистой классификации права писать
// (channel-write-access). Покрывают все ветки перечня причин §3 requirements-v1.md.
// Запуск: `node --import tsx --test src/core/write-access.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    isPermanentReason,
    classifyParticipant,
    classifySendError,
    classifyDefaultBannedRights,
    type SelfParticipantState,
} from "./write-access";

// Хелпер: строит вариант `participant` с сырым TL-объектом (className-дискриминация)
// и постоянной величиной группы обсуждения.
const participantState = (
    participant: Record<string, unknown>,
    defaultBannedSendMessages = false,
): SelfParticipantState => ({ kind: "participant", participant: participant as any, defaultBannedSendMessages });

test("isPermanentReason: постоянные — members_restricted и paid, переменные — нет", () => {
    assert.equal(isPermanentReason("members_restricted"), true);
    assert.equal(isPermanentReason("paid"), true);
    assert.equal(isPermanentReason("account_muted"), false);
    assert.equal(isPermanentReason("account_kicked"), false);
    assert.equal(isPermanentReason("not_participant"), false);
    assert.equal(isPermanentReason("CHAT_WRITE_FORBIDDEN"), false);
});

test("classifyParticipant: обычный участник, постоянная разрешает → can_write (null)", () => {
    assert.equal(classifyParticipant(participantState({ className: "ChannelParticipant" })), null);
    assert.equal(classifyParticipant(participantState({ className: "ChannelParticipantSelf" })), null);
    assert.equal(classifyParticipant(participantState({ className: "ChannelParticipantAdmin" })), null);
    assert.equal(classifyParticipant(participantState({ className: "ChannelParticipantCreator" })), null);
});

test("classifyParticipant: обычный участник, но постоянная запрещает → members_restricted", () => {
    const verdict = classifyParticipant(participantState({ className: "ChannelParticipant" }, true));
    assert.deepEqual(verdict, { reason: "members_restricted", until: null });
});

test("classifyParticipant: channelParticipantBanned send_messages=true, left=false → account_muted (+until)", () => {
    const verdict = classifyParticipant(
        participantState({ className: "ChannelParticipantBanned", left: false, bannedRights: { sendMessages: true, untilDate: 1893456000 } }),
    );
    assert.deepEqual(verdict, { reason: "account_muted", until: 1893456000 });
});

test("classifyParticipant: account_muted с untilDate=0 → until=null (бессрочно, справочно)", () => {
    const verdict = classifyParticipant(
        participantState({ className: "ChannelParticipantBanned", left: false, bannedRights: { sendMessages: true, untilDate: 0 } }),
    );
    assert.deepEqual(verdict, { reason: "account_muted", until: null });
});

test("classifyParticipant: channelParticipantBanned left=true → account_kicked", () => {
    const verdict = classifyParticipant(
        participantState({ className: "ChannelParticipantBanned", left: true, bannedRights: { sendMessages: true, untilDate: 0 } }),
    );
    assert.deepEqual(verdict, { reason: "account_kicked", until: null });
});

test("classifyParticipant: бан-запись без запрета текста (send_messages=false) → упирается в постоянную", () => {
    // Постоянная разрешает — текст отправить можно (R5 бинарно).
    assert.equal(
        classifyParticipant(participantState({ className: "ChannelParticipantBanned", left: false, bannedRights: { sendMessages: false } })),
        null,
    );
    // Постоянная запрещает — members_restricted.
    assert.deepEqual(
        classifyParticipant(participantState({ className: "ChannelParticipantBanned", left: false, bannedRights: { sendMessages: false } }, true)),
        { reason: "members_restricted", until: null },
    );
});

test("classifyParticipant: channelParticipantLeft → not_participant", () => {
    const verdict = classifyParticipant(participantState({ className: "ChannelParticipantLeft" }));
    assert.deepEqual(verdict, { reason: "not_participant", until: null });
});

test("classifyParticipant: USER_NOT_PARTICIPANT (kind=not_participant) → not_participant", () => {
    const verdict = classifyParticipant({ kind: "not_participant" });
    assert.deepEqual(verdict, { reason: "not_participant", until: null });
});

test("classifyParticipant: USER_BANNED_IN_CHANNEL (kind=banned_in_channel) → account_kicked", () => {
    const verdict = classifyParticipant({ kind: "banned_in_channel" });
    assert.deepEqual(verdict, { reason: "account_kicked", until: null });
});

test("classifySendError: голый CHAT_WRITE_FORBIDDEN → CHAT_WRITE_FORBIDDEN (переменная)", () => {
    assert.equal(classifySendError("chat_write_forbidden"), "CHAT_WRITE_FORBIDDEN");
});

test("classifySendError: user_banned_in_channel → account_kicked", () => {
    assert.equal(classifySendError("user_banned_in_channel"), "account_kicked");
});

test("classifySendError: allow_payment_required → paid (постоянная)", () => {
    assert.equal(classifySendError("allow_payment_required"), "paid");
});

test("classifySendError: PEER_FLOOD (R13) не приписывается каналу → null", () => {
    assert.equal(classifySendError("peer_flood"), null);
});

test("classifySendError: прочие теги и отсутствие тега (в т.ч. slowmode — гасится ретраем выше) → null", () => {
    // SLOWMODE_WAIT (R12) до классификатора не долетает (parseFloodWait ретраит),
    // формат-запреты и отсутствие тега — не про право записи.
    assert.equal(classifySendError("chat_send_plain_forbidden"), null);
    assert.equal(classifySendError("chat_send_media_forbidden"), null);
    assert.equal(classifySendError("channel_private"), null);
    assert.equal(classifySendError(null), null);
});

test("classifyDefaultBannedRights: send_messages=true → members_restricted, иначе null", () => {
    assert.equal(classifyDefaultBannedRights(true), "members_restricted");
    assert.equal(classifyDefaultBannedRights(false), null);
});
