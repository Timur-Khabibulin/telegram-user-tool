// core/write-access.ts — классификация права писать в канал (channel-write-access).
//
// Единственный дом классификации сигнал → причина «писать нельзя» («один факт —
// один дом»). Без I/O: чистые функции над уже полученными значениями (статус
// участника, код ошибки отправки, постоянная величина при вступлении), тестируется
// изолированно (write-access.test.ts).
//
// Признак «писать нельзя» = `write_access_reason IS NOT NULL` (хранится в channels,
// отдельно от `status` жизненного цикла — R6). Тип причины (постоянная/переменная)
// не хранится, а выводится из значения (`isPermanentReason`).

import type { Api } from "telegram";
import type { TelegramErrorTag } from "./telegram/errors";

/**
 * Перечень причин «писать нельзя» (requirements-v1.md §3). Постоянные
 * (`isPermanentReason`) удерживают канал read-only; переменные ведут к ротации
 * через `status='banned'`. `no_discussion` в тип входит для полноты перечня, но в
 * колонку `channels.write_access_reason` не попадает — фиксируется на уровне
 * `join_queue` (broadcast без группы обсуждения не вступается, строки канала нет).
 */
export type WriteAccessReason =
    | "members_restricted"
    | "no_discussion"
    | "paid"
    | "account_muted"
    | "account_kicked"
    | "not_participant"
    | "CHAT_WRITE_FORBIDDEN";

/**
 * Постоянные причины — те, что могут оказаться в колонке `write_access_reason` и
 * удерживают канал read-only (§2.1). `no_discussion` сюда не входит: он не пишется
 * в колонку, поэтому `isPermanentReason` на нём никогда не вызывается.
 */
const PERMANENT_REASONS: ReadonlySet<WriteAccessReason> = new Set<WriteAccessReason>([
    "members_restricted",
    "paid",
]);

/** Постоянная ли причина: удержать read-only (true) или вести в ротацию (false). */
export function isPermanentReason(reason: WriteAccessReason): boolean {
    return PERMANENT_REASONS.has(reason);
}

/**
 * Нормализованный исход `GetParticipant(self)` в группе обсуждения. `USER_NOT_PARTICIPANT`
 * и `USER_BANNED_IN_CHANNEL` приходят ОШИБКОЙ вызова (а не объектом участника), поэтому
 * tg-слой нормализует их в отдельные kind'ы. Для варианта `participant` дополнительно
 * пробрасывается постоянная величина группы обсуждения (`default_banned_rights.send_messages`)
 * — она приходит в том же ответе бесплатно и уточняет can_write без отдельного вызова.
 */
export type SelfParticipantState =
    | { kind: "participant"; participant: Api.TypeChannelParticipant; defaultBannedSendMessages: boolean }
    | { kind: "not_participant" }
    | { kind: "banned_in_channel" };

/**
 * Результат классификации участника: причина «писать нельзя» + справочный
 * `until` (срок персонального ограничения, только для `account_muted`; для
 * остальных причин null). `null` (не объект) = can_write.
 */
export interface ParticipantVerdict {
    reason: WriteAccessReason;
    until: number | null;
}

/** `until_date` из `banned_rights`: 0/отсутствие = бессрочно (null), храним справочно (R11). */
function normalizeUntil(untilDate: unknown): number | null {
    return typeof untilDate === "number" && untilDate > 0 ? untilDate : null;
}

/**
 * Классифицирует живой статус участника в причину «писать нельзя» или `null`
 * (can_write). Разбор конструкторов участника — по `className` (стабильное имя
 * TL-типа GramJS), чтобы модуль оставался без runtime-зависимости от `telegram`.
 * Маппинг §3 requirements-v1.md:
 *   - не участник / `channelParticipantLeft` → `not_participant`;
 *   - `channelParticipantBanned` `left=true` / бан на уровне канала → `account_kicked`;
 *   - `channelParticipantBanned` `send_messages=true`, `left=false` → `account_muted` (+until);
 *   - обычный/self/admin/creator И постоянная величина запрещает → `members_restricted`;
 *   - иначе → `null` (can_write).
 */
export function classifyParticipant(state: SelfParticipantState): ParticipantVerdict | null {
    if (state.kind === "not_participant") return { reason: "not_participant", until: null };
    if (state.kind === "banned_in_channel") return { reason: "account_kicked", until: null };

    const p = state.participant as { className?: string; left?: boolean; bannedRights?: { sendMessages?: boolean; untilDate?: number } };

    if (p.className === "ChannelParticipantLeft") return { reason: "not_participant", until: null };

    if (p.className === "ChannelParticipantBanned") {
        if (p.left === true) return { reason: "account_kicked", until: null };
        // Бан-запись без запрета отправки (например, ограничены только медиа) — при
        // бинарной гранулярности (R5) текст отправить всё ещё можно: падаем ниже к
        // проверке постоянной величины.
        if (p.bannedRights?.sendMessages === true) {
            return { reason: "account_muted", until: normalizeUntil(p.bannedRights.untilDate) };
        }
    }

    // Обычный участник / self / admin / creator (или бан без запрета текста): переменная
    // величина писать разрешает — эффективное право упирается только в постоянную.
    if (state.defaultBannedSendMessages) return { reason: "members_restricted", until: null };
    return null;
}

/**
 * Классифицирует код ошибки отправки в причину «писать нельзя» или `null`
 * (сигнал не про право записи — пропускаем). Реактивный резерв (R14): ловит
 * причины, невидимые проактивно (`CHAT_WRITE_FORBIDDEN`, `paid`).
 * `peer_flood` (R13, уровень аккаунта) и все прочие теги (в т.ч. отсутствие тега)
 * → `null`; `SLOWMODE_WAIT` (R12) до сюда не долетает — гасится `parseFloodWait`
 * ретраем выше по потоку.
 */
export function classifySendError(tag: TelegramErrorTag | null): WriteAccessReason | null {
    switch (tag) {
        case "chat_write_forbidden":
            return "CHAT_WRITE_FORBIDDEN";
        case "user_banned_in_channel":
            return "account_kicked";
        case "allow_payment_required":
            return "paid";
        default:
            return null;
    }
}

/**
 * Классифицирует постоянную величину права (при вступлении, R3): запрет отправки
 * всем рядовым участникам группы обсуждения (`default_banned_rights.send_messages`)
 * → `members_restricted`, иначе `null` (постоянная величина писать разрешает).
 */
export function classifyDefaultBannedRights(defaultBannedSendMessages: boolean): WriteAccessReason | null {
    return defaultBannedSendMessages ? "members_restricted" : null;
}
