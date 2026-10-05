// core/write-access.test.ts — юнит-тесты чистой классификации права писать
// (channel-write-access-proactive). Покрывают ветки classifyWriteAccess §2.3.
// Запуск: `node --import tsx --test src/core/write-access.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    classifyWriteAccess,
    levelOfDetected,
    SLOWMODE_SUSPEND_DEFAULT_SECONDS,
    type WriteAccessSnapshot,
    type DiscussionFlags,
    type ParticipantSnapshot,
} from "./write-access";

const flags = (over: Partial<DiscussionFlags> = {}): DiscussionFlags => ({
    left: false,
    restricted: false,
    restrictionReason: [],
    slowmodeEnabled: false,
    joinToSend: false,
    joinRequest: false,
    defaultBannedSendMessages: false,
    ...over,
});

const snap = (participant: ParticipantSnapshot, discussion: Partial<DiscussionFlags> = {}): WriteAccessSnapshot => ({
    discussion: flags(discussion),
    participant,
    slowmodeDefaultSeconds: SLOWMODE_SUSPEND_DEFAULT_SECONDS,
});

const participant = (tl: Record<string, unknown>): ParticipantSnapshot => ({ kind: "participant", participant: tl as any });
const okParticipant = participant({ className: "ChannelParticipant" });

test("restricted → suspend бессрочный (channel_restricted), приоритет над участником", () => {
    const a = classifyWriteAccess(snap({ kind: "not_participant" }, { restricted: true, restrictionReason: [{ platform: "ios", reason: "porn", text: "x" }] }));
    assert.equal(a.kind, "suspend");
    if (a.kind === "suspend") {
        assert.equal(a.durationSeconds, null);
        assert.equal(a.detected, "channel_restricted");
        assert.deepEqual(a.details.restrictionReason, [{ platform: "ios", reason: "porn", text: "x" }]);
    }
});

test("default_banned_rights → suspend бессрочный (members_restricted)", () => {
    const a = classifyWriteAccess(snap(okParticipant, { defaultBannedSendMessages: true }));
    assert.equal(a.kind, "suspend");
    if (a.kind === "suspend") assert.equal(a.detected, "members_restricted");
});

test("channel.left → авторотация (channel_left)", () => {
    const a = classifyWriteAccess(snap(okParticipant, { left: true }));
    assert.equal(a.kind, "autorotate");
    if (a.kind === "autorotate") assert.equal(a.detected, "channel_left");
});

test("forbidden (доступ потерян) → авторотация (channel_forbidden)", () => {
    const a = classifyWriteAccess(snap({ kind: "forbidden" }));
    assert.equal(a.kind, "autorotate");
    if (a.kind === "autorotate") assert.equal(a.detected, "channel_forbidden");
});

test("banned_in_channel → авторотация (participant_banned)", () => {
    const a = classifyWriteAccess(snap({ kind: "banned_in_channel" }));
    assert.equal(a.kind, "autorotate");
    if (a.kind === "autorotate") assert.equal(a.detected, "participant_banned");
});

test("ChannelParticipantBanned left=true → авторотация с kicked_by/date/banned_rights", () => {
    const a = classifyWriteAccess(
        snap(participant({ className: "ChannelParticipantBanned", left: true, kickedBy: 42, date: 111, bannedRights: { sendMessages: true, untilDate: 0 } })),
    );
    assert.equal(a.kind, "autorotate");
    if (a.kind === "autorotate") {
        assert.equal(a.detected, "participant_banned");
        assert.equal(a.details.kickedBy, "42");
        assert.equal(a.details.date, 111);
        assert.deepEqual(a.details.bannedRights, { sendMessages: true, untilDate: null });
    }
});

test("ChannelParticipantBanned send_messages=true, left=false → авторотация", () => {
    const a = classifyWriteAccess(snap(participant({ className: "ChannelParticipantBanned", left: false, bannedRights: { sendMessages: true, untilDate: 999 } })));
    assert.equal(a.kind, "autorotate");
    if (a.kind === "autorotate") assert.deepEqual(a.details.bannedRights, { sendMessages: true, untilDate: 999 });
});

test("ChannelParticipantBanned без запрета текста → ok (пишем текст)", () => {
    const a = classifyWriteAccess(snap(participant({ className: "ChannelParticipantBanned", left: false, bannedRights: { sendMessages: false } })));
    assert.equal(a.kind, "ok");
});

test("не участник без цензов → авторотация (participant_left)", () => {
    const a = classifyWriteAccess(snap({ kind: "not_participant" }));
    assert.equal(a.kind, "autorotate");
    if (a.kind === "autorotate") assert.equal(a.detected, "participant_left");
});

test("не участник + join_to_send → вступление (join)", () => {
    const a = classifyWriteAccess(snap({ kind: "not_participant" }, { joinToSend: true }));
    assert.equal(a.kind, "join");
    if (a.kind === "join") assert.equal(a.detected, "join_to_send");
});

test("не участник + join_request → заявка (приоритет над join_to_send)", () => {
    const a = classifyWriteAccess(snap({ kind: "not_participant" }, { joinToSend: true, joinRequest: true }));
    assert.equal(a.kind, "join_request");
    if (a.kind === "join_request") assert.equal(a.detected, "join_request");
});

test("ChannelParticipantLeft → как не участник (авторотация)", () => {
    const a = classifyWriteAccess(snap(participant({ className: "ChannelParticipantLeft" })));
    assert.equal(a.kind, "autorotate");
    if (a.kind === "autorotate") assert.equal(a.detected, "participant_left");
});

test("slow-mode у участника → suspend временный", () => {
    const a = classifyWriteAccess(snap(okParticipant, { slowmodeEnabled: true }));
    assert.equal(a.kind, "suspend");
    if (a.kind === "suspend") {
        assert.equal(a.detected, "slowmode");
        assert.equal(a.durationSeconds, SLOWMODE_SUSPEND_DEFAULT_SECONDS);
    }
});

test("обычный участник без препятствий → ok", () => {
    assert.equal(classifyWriteAccess(snap(okParticipant)).kind, "ok");
});

test("levelOfDetected: канальные vs аккаунтные", () => {
    assert.equal(levelOfDetected("channel_restricted"), "channel");
    assert.equal(levelOfDetected("members_restricted"), "channel");
    assert.equal(levelOfDetected("slowmode"), "channel");
    assert.equal(levelOfDetected("participant_banned"), "account");
    assert.equal(levelOfDetected("channel_left"), "account");
    assert.equal(levelOfDetected("participant_left"), "account");
});
