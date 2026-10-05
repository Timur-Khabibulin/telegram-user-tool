// core/write-access.ts — классификация права писать в канал (проактивная модель).
//
// Единственный дом маппинга «статус канала/участника → действие»
// (channel-write-access-proactive). Без I/O: чистая функция над уже полученным
// снимком (участник + флаги группы обсуждения), тестируется изолированно
// (write-access.test.ts). Требования — docs/design/channel-write-access/requirements-v1.md;
// архитектура — architecture.md §2.
//
// Признак «писать нельзя» отдельной колонкой НЕ хранится: действие уводит канал в
// `status` (`banned`/`suspend`) или в очередь вступления, а гейт отправок/чтения
// обеспечивается исключением таких каналов из `getChannelsBatch`.

import type { Api } from "telegram";

/** Дефолт длительности временного suspend при slow-mode (нет доп. GetFullChannel, §12.8). */
export const SLOWMODE_SUSPEND_DEFAULT_SECONDS = 6 * 60 * 60;

/** Причина ограничения канала самим Telegram (`restrictionReason`). */
export interface RestrictionReasonInfo {
    platform: string;
    reason: string;
    text: string;
}

/**
 * Флаги группы обсуждения из ответа `GetParticipant` (объект `channel` в `chats`).
 * Для неучастника флаги недоступны (объекта нет) — заполняются дефолтами (false),
 * что по §12.5 даёт авторотацию вместо вступления.
 */
export interface DiscussionFlags {
    left: boolean;
    restricted: boolean;
    restrictionReason: RestrictionReasonInfo[];
    slowmodeEnabled: boolean;
    joinToSend: boolean;
    joinRequest: boolean;
    defaultBannedSendMessages: boolean;
}

/**
 * Нормализованный исход `GetParticipant(self)`. `USER_NOT_PARTICIPANT` и
 * `USER_BANNED_IN_CHANNEL` приходят ОШИБКОЙ вызова (не объектом) — tg-слой
 * нормализует их в отдельные kind'ы.
 */
export type ParticipantSnapshot =
    | { kind: "participant"; participant: Api.TypeChannelParticipant }
    | { kind: "not_participant" }
    | { kind: "banned_in_channel" }
    | { kind: "forbidden" }; // chatForbidden / channelForbidden / CHANNEL_PRIVATE — доступ потерян

/** Снимок статусов канала/участника перед отправкой — вход классификатора. */
export interface WriteAccessSnapshot {
    discussion: DiscussionFlags;
    participant: ParticipantSnapshot;
    slowmodeDefaultSeconds: number;
}

/** Обнаруженный статус права записи (ключ события журнала). */
export type DetectedStatus =
    | "channel_restricted"
    | "members_restricted"
    | "channel_left"
    | "channel_forbidden"
    | "participant_banned"
    | "participant_left"
    | "slowmode"
    | "join_to_send"
    | "join_request";

/** Детали препятствия для журнала (payload события `write_access`). */
export interface WriteAccessDetails {
    kickedBy?: string;
    date?: number;
    bannedRights?: { sendMessages: boolean; untilDate: number | null };
    restrictionReason?: RestrictionReasonInfo[];
}

/** Действие по обнаруженному статусу. `ok` = писать можно. */
export type WriteAccessAction =
    | { kind: "ok" }
    | { kind: "autorotate"; detected: DetectedStatus; details: WriteAccessDetails }
    | { kind: "suspend"; durationSeconds: number | null; detected: DetectedStatus; details: WriteAccessDetails }
    | { kind: "join"; detected: DetectedStatus; details: WriteAccessDetails }
    | { kind: "join_request"; detected: DetectedStatus; details: WriteAccessDetails };

/** Уровень статуса: канал (действует для всех) или аккаунт (только наш). */
export function levelOfDetected(detected: DetectedStatus): "channel" | "account" {
    switch (detected) {
        case "channel_restricted":
        case "members_restricted":
        case "slowmode":
        case "join_to_send":
        case "join_request":
            return "channel";
        default:
            return "account";
    }
}

/** `until_date`: 0/отсутствие = бессрочно (null), иначе значение (справочно, R11/R15). */
function normalizeUntil(untilDate: unknown): number | null {
    return typeof untilDate === "number" && untilDate > 0 ? untilDate : null;
}

/** Действие в ветке «не участник»: заявка > вступление > авторотация (§2.3 шаг 5). */
function notParticipantAction(d: DiscussionFlags): WriteAccessAction {
    if (d.joinRequest) return { kind: "join_request", detected: "join_request", details: {} };
    if (d.joinToSend) return { kind: "join", detected: "join_to_send", details: {} };
    return { kind: "autorotate", detected: "participant_left", details: {} };
}

/**
 * Классифицирует снимок в ровно одно действие. Порядок разбора (architecture §2.3):
 * сначала уровень канала (авторотация не поможет), затем уровень аккаунта.
 *   1. `restricted` (канал ограничен Telegram) → suspend(∞)
 *   2. `default_banned_rights.send_messages` (все замьючены) → suspend(∞)
 *   3. `channel.left` (вышли) → авторотация
 *   4. бан участника (`banned_in_channel`; `ChannelParticipantBanned` с `left=true`
 *      или `send_messages=true`) → авторотация (+kicked_by/date/banned_rights)
 *   5. не участник / `ChannelParticipantLeft` → заявка/вступление/авторотация
 *   6. slow-mode → suspend временный
 *   7. иначе → ok
 */
export function classifyWriteAccess(s: WriteAccessSnapshot): WriteAccessAction {
    const d = s.discussion;

    if (d.restricted) {
        return { kind: "suspend", durationSeconds: null, detected: "channel_restricted", details: { restrictionReason: d.restrictionReason } };
    }
    if (d.defaultBannedSendMessages) {
        return { kind: "suspend", durationSeconds: null, detected: "members_restricted", details: {} };
    }
    if (d.left) {
        return { kind: "autorotate", detected: "channel_left", details: {} };
    }

    const p = s.participant;
    if (p.kind === "forbidden") {
        return { kind: "autorotate", detected: "channel_forbidden", details: {} };
    }
    if (p.kind === "banned_in_channel") {
        return { kind: "autorotate", detected: "participant_banned", details: {} };
    }
    if (p.kind === "not_participant") {
        return notParticipantAction(d);
    }

    // p.kind === "participant" — разбор конструктора по стабильному className.
    const pp = p.participant as {
        className?: string;
        left?: boolean;
        kickedBy?: { toString(): string };
        date?: number;
        bannedRights?: { sendMessages?: boolean; untilDate?: number };
    };
    if (pp.className === "ChannelParticipantLeft") {
        return notParticipantAction(d);
    }
    if (pp.className === "ChannelParticipantBanned") {
        const details: WriteAccessDetails = {
            kickedBy: pp.kickedBy?.toString(),
            date: pp.date,
            bannedRights: {
                sendMessages: pp.bannedRights?.sendMessages === true,
                untilDate: normalizeUntil(pp.bannedRights?.untilDate),
            },
        };
        if (pp.left === true) return { kind: "autorotate", detected: "participant_banned", details };
        // Бан без запрета текста (ограничены только медиа) — при бинарной
        // гранулярности «хотя бы текст» писать можно; падаем ниже.
        if (pp.bannedRights?.sendMessages === true) return { kind: "autorotate", detected: "participant_banned", details };
    }

    // Обычный участник / self / admin / creator (или бан без запрета текста).
    if (d.slowmodeEnabled) {
        return { kind: "suspend", durationSeconds: s.slowmodeDefaultSeconds, detected: "slowmode", details: {} };
    }
    return { kind: "ok" };
}
