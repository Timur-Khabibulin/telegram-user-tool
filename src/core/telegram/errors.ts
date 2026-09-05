// core/telegram/errors.ts — типизированные ошибки Telegram-сервиса.

import { errors as gramjsErrors } from "telegram";
import type { Logger } from "../logger";

/** Telegram вернул FLOOD_WAIT — нужно подождать waitSeconds секунд перед повтором. */
export class FloodWaitError extends Error {
    constructor(public readonly waitSeconds: number) {
        super(`FLOOD_WAIT_${waitSeconds}`);
        this.name = "FloodWaitError";
    }
}

/**
 * Верхняя граница инлайн-ожидания флуд-ограничения внутри одного прогона задачи,
 * запланированной через `dispatcher.ts`/systemd-таймер (join-queue, monitor,
 * monitor-v2, dm-send). Прогон жёстко ограничен `TimeoutStartSec=3600`
 * (`openspec/specs/task-scheduler/spec.md`) — ожидание на пороге или выше не
 * укладывается в этот лимит и откладывается на следующий плановый тик вместо
 * блокирующего `sleep` внутри текущего прогона. Не применяется к шести
 * admin-скриптовым методам сервиса (`resolveOwnChannel` и т.п.) — они не запускаются
 * через диспетчер и не подпадают под этот таймаут (см. design.md flood-wait-detection,
 * Non-Goals).
 */
export const MAX_INLINE_FLOOD_WAIT_SECONDS = 120;

/**
 * Извлекает длительность флуд-ограничения (`FLOOD_WAIT`, slow-mode) из исключения
 * GramJS по структурному типу — не по тексту сообщения. `err.message` для этих ошибок
 * GramJS формирует сам ("A wait of N seconds is required...",
 * `node_modules/telegram/errors/RPCErrorList.js`) и никогда не содержит исходный код
 * Telegram (`FLOOD_WAIT_N`) — regex по тексту сообщения не сработает ни при каких
 * условиях. `FloodWaitError`/`SlowModeWaitError` — конкретные подклассы `FloodError`
 * (код 420), каждый сам объявляет `seconds: number`
 * (`node_modules/telegram/errors/RPCErrorList.d.ts`); у базового `FloodError` этого
 * поля в объявлении типов нет, поэтому проверяются два конкретных подкласса, не общий
 * предок. Единственное место этой проверки в проекте — импортируется отовсюду, где
 * раньше был локальный regex-парсинг.
 */
export function parseFloodWait(err: unknown): number | null {
    if (err instanceof gramjsErrors.FloodWaitError || err instanceof gramjsErrors.SlowModeWaitError) {
        return err.seconds;
    }
    return null;
}

/**
 * Подключение к Telegram недоступно — прогон/цикл пора остановить. Абстрактный
 * маркер: не бросается напрямую, только через конкретные подклассы
 * (MissingAccountConfigError / ConnectTimeoutError / SessionRevokedError). Каждый
 * подкласс сам описывает свою причину в message и в this.name — здесь остаётся
 * только общий `instanceof`-контракт для control-flow (dispatcher.ts,
 * discovery/similar.ts) и проброс cause.
 */
export abstract class ClientNotConnectedError extends Error {
    protected constructor(message: string, public readonly cause?: unknown) {
        super(message);
    }
}

/**
 * Не заполнено обязательное поле аккаунта (apiId/apiHash/sessionString) в
 * tg-account.json — конфигурационный баг, ретраи в рамках прогона бессмысленны.
 */
export class MissingAccountConfigError extends ClientNotConnectedError {
    constructor(field: "apiId" | "apiHash" | "sessionString") {
        super(`tg-account.json: отсутствует ${field}`);
        this.name = "MissingAccountConfigError";
    }
}

/**
 * Все попытки connect() исчерпаны по таймауту — временная перегрузка сети/VPS/
 * прокси, самовосстанавливается; ретрай на следующем плановом тике осмыслен.
 */
export class ConnectTimeoutError extends ClientNotConnectedError {
    constructor(
        timeoutMs: number,
        attempt: number,
        maxAttempts: number,
        proxy?: { host: string; port: number },
        cause?: unknown,
    ) {
        const proxyInfo = proxy ? ` via proxy ${proxy.host}:${proxy.port}` : "";
        super(`connect timed out after ${timeoutMs / 1000}s (попытка ${attempt}/${maxAttempts}${proxyInfo})`, cause);
        this.name = "ConnectTimeoutError";
    }
}

/**
 * Telegram вернул RPC-ошибку с кодом 401 — сессия невалидна/отозвана (например
 * AUTH_KEY_UNREGISTERED) — либо API_ID_INVALID (код 400, неверный apiId/apiHash в
 * tg-account.json, telegram-error-handling №8). Ретраи бессмысленны, нужна
 * переавторизация/правка конфигурации человеком.
 */
export class SessionRevokedError extends ClientNotConnectedError {
    constructor(code: number, errorMessage: string) {
        super(`${code}: ${errorMessage}`);
        this.name = "SessionRevokedError";
    }
}

/**
 * Аккаунт удалён/забанен Telegram целиком (USER_DEACTIVATED,
 * USER_DEACTIVATED_BAN) либо заморожен до прохождения проверки/апелляции
 * (FROZEN_PARTICIPANT_MISSING, FROZEN_METHOD_INVALID) — telegram-error-handling
 * №5/6/11/12. В отличие от SessionRevokedError может возникать в любом
 * MTProto-вызове, не только при connect()/getMe(). Наследуется от того же
 * маркера, что и остальные ошибки подключения — тот же control-flow «прогон
 * пора останавливать».
 */
export class AccountBannedError extends ClientNotConnectedError {
    constructor(code: number | undefined, errorMessage: string) {
        super(`${code ?? "?"}: ${errorMessage}`);
        this.name = "AccountBannedError";
    }
}

// ─── Классификация аккаунтных ошибок (telegram-error-handling) ────────────

const NEED_UPDATE_SESSION_MESSAGES = [
    "AUTH_KEY_UNREGISTERED",
    "SESSION_REVOKED",
    "SESSION_EXPIRED",
    "AUTH_KEY_DUPLICATED",
    "API_ID_INVALID",
];

const ACCOUNT_BANNED_MESSAGES = [
    "USER_DEACTIVATED",
    "USER_DEACTIVATED_BAN",
    "FROZEN_PARTICIPANT_MISSING",
    "FROZEN_METHOD_INVALID",
];

/**
 * Классифицирует аккаунтную ошибку (раздел 1 docs/telegram-errors.md) по
 * сырому `errorMessage`, не по коду — код 401 сам по себе покрывает и
 * `need_update_session`, и часть `banned`-причин (см. design.md
 * telegram-error-handling, Decisions), поэтому текст проверяется первым.
 * Код 401 без совпадения по тексту (прочие причины UnauthorizedError) —
 * fallback на `need_update_session`, как и раньше для SessionRevokedError.
 * `FROZEN_METHOD_INVALID` (код 420, общий с FLOOD_WAIT/SLOWMODE_WAIT)
 * различается только по этому списку текстов — `parseFloodWait` его не
 * матчит (конкретные подклассы GramJS для другого текста), конфликта нет.
 */
export function classifyAccountError(err: unknown): "need_update_session" | "banned" | null {
    const e = err as any;
    const msg: string = typeof e?.errorMessage === "string" ? e.errorMessage : (e?.message ?? "");
    if (ACCOUNT_BANNED_MESSAGES.some((m) => msg.includes(m))) return "banned";
    if (NEED_UPDATE_SESSION_MESSAGES.some((m) => msg.includes(m))) return "need_update_session";
    if (typeof e?.code === "number" && e.code === 401) return "need_update_session";
    return null;
}

// ─── Классификация операционных ошибок (join/send, telegram-error-handling) ──

/** Теги операционных ошибок — разделы 2-3 docs/telegram-errors.md (join/send). */
export type TelegramErrorTag =
    | "username_not_occupied"
    | "username_invalid"
    | "channel_private"
    | "channel_invalid"
    | "user_already_participant"
    | "invite_request_sent"
    | "invite_hash_expired"
    | "invite_hash_invalid"
    | "channels_too_much"
    | "users_too_much"
    | "user_banned_in_channel"
    | "chat_write_forbidden"
    | "chat_send_plain_forbidden"
    | "chat_send_media_forbidden"
    | "allow_payment_required"
    | "peer_flood";

const ERROR_TAG_BY_MESSAGE: Record<string, TelegramErrorTag> = {
    USERNAME_NOT_OCCUPIED: "username_not_occupied",
    USERNAME_INVALID: "username_invalid",
    CHANNEL_PRIVATE: "channel_private",
    CHANNEL_INVALID: "channel_invalid",
    USER_ALREADY_PARTICIPANT: "user_already_participant",
    INVITE_REQUEST_SENT: "invite_request_sent",
    INVITE_HASH_EXPIRED: "invite_hash_expired",
    INVITE_HASH_INVALID: "invite_hash_invalid",
    CHANNELS_TOO_MUCH: "channels_too_much",
    USERS_TOO_MUCH: "users_too_much",
    USER_BANNED_IN_CHANNEL: "user_banned_in_channel",
    CHAT_WRITE_FORBIDDEN: "chat_write_forbidden",
    CHAT_SEND_PLAIN_FORBIDDEN: "chat_send_plain_forbidden",
    CHAT_SEND_MEDIA_FORBIDDEN: "chat_send_media_forbidden",
    ALLOW_PAYMENT_REQUIRED: "allow_payment_required",
    PEER_FLOOD: "peer_flood",
};

/**
 * Классифицирует операционную (join/send) ошибку по сырому `errorMessage` —
 * возвращает тег, не бросает. Не возвращённый (`null`) `errorMessage` означает
 * ошибку вне этого каталога — вызывающий сам решает, как её трактовать.
 */
export function classifyTelegramErrorTag(err: unknown): TelegramErrorTag | null {
    const e = err as any;
    const msg: string = typeof e?.errorMessage === "string" ? e.errorMessage : (e?.message ?? "");
    for (const [needle, tag] of Object.entries(ERROR_TAG_BY_MESSAGE)) {
        if (msg.includes(needle)) return tag;
    }
    return null;
}

// ─── Единый ретрай FLOOD_WAIT/SLOWMODE_WAIT (telegram-error-handling) ─────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Повторяет операцию при FLOOD_WAIT/SLOWMODE_WAIT до `maxRetries` раз подряд
 * (дефолт 2 — telegram-error-handling №9/№28), если время ожидания меньше
 * `MAX_INLINE_FLOOD_WAIT_SECONDS`. Порог перепроверяется на каждой поимке
 * ошибки (не только при первом возникновении) — как только очередное время
 * ожидания окажется ≥ порога или ретраи исчерпаны, бросается исходная ошибка
 * (не оборачивается) — вызывающий сам решает, что делать дальше вне скоупа
 * этой ошибки. Единственная реализация ретрая флуда в проекте — раньше была
 * продублирована трижды (`skills/util.ts`, `sendDm`, `joinDiscussionGroups`).
 */
export async function retryOnFloodWait<T>(
    fn: () => Promise<T>,
    log: Pick<Logger, "warn">,
    maxRetries = 2,
): Promise<T> {
    for (let retry = 0; ; retry++) {
        try {
            return await fn();
        } catch (err: any) {
            const waitSec = parseFloodWait(err);
            if (waitSec === null || waitSec >= MAX_INLINE_FLOOD_WAIT_SECONDS || retry >= maxRetries) throw err;
            log.warn(`[telegram] FLOOD_WAIT ${waitSec}s — waiting and retrying (${retry + 1}/${maxRetries})`);
            await sleep(waitSec * 1000);
        }
    }
}
