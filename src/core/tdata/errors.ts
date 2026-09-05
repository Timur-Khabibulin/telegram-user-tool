// core/tdata/errors.ts — ошибки расшифровки/подготовки tdata-сессии (R-1).

/** Не удалось подключиться через данный прокси-кандидат (сеть/прокси/расшифровка tdata) — ретрай со следующим кандидатом. */
export class TdataConnectError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = "TdataConnectError";
    }
}

/**
 * Подключение успешно, но подготовка аккаунта (очистка/2FA/сессии/профиль/канал)
 * упала с ошибкой Telegram API — смена прокси не поможет, подбор прекращается сразу (R-1).
 */
export class TdataSetupError extends Error {
    constructor(public readonly telegramCode: string, message: string, public readonly cause?: unknown) {
        super(message);
        this.name = "TdataSetupError";
    }
}
