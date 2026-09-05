// core/tg-agent-autoregistration/agentic-session.ts — вторая (агентская) MTProto-сессия.
//
// Регистрируется отдельно от bootstrap-сессии, общими apiId/apiHash персоны
// (R-D1). Код авторизации приходит на ещё активное bootstrap-соединение —
// readIncomingCode (core/tdata) слушает его напрямую. Bootstrap-сессия после
// успеха НЕ разлогинивается (architecture.md §2.2/D3) — обе сессии остаются
// активными на аккаунте.

import type { TelegramClient } from "telegram";
import type { Logger } from "../logger";
import { TelegramService } from "../telegram/service";
import { readIncomingCode } from "../tdata";
import type { ProxyConfig } from "../config";

/** R-D5: фиксированная константа, не параметр запуска. */
export const READ_INCOMING_CODE_TIMEOUT_MS = 2 * 60_000;

export type AgenticSessionOutcome = { kind: "signed_in"; sessionString: string } | { kind: "code_timeout" };

export async function registerAgenticSession(
    bootstrapClient: TelegramClient,
    apiId: number,
    apiHash: string,
    phoneNumber: string,
    proxy: ProxyConfig,
    newPassword: string,
    log: Logger,
): Promise<AgenticSessionOutcome> {
    const tg = new TelegramService(log);
    try {
        const { phoneCodeHash } = await tg.authSendCode({ apiId, apiHash, phoneNumber, proxy });

        const phoneCode = await readIncomingCode(bootstrapClient, READ_INCOMING_CODE_TIMEOUT_MS, log);
        if (phoneCode === null) {
            return { kind: "code_timeout" };
        }

        const result = await tg.authSignIn({ phoneNumber, phoneCodeHash, phoneCode, password: newPassword });
        if ("needsPassword" in result) {
            // 2FA уже сменён на этом аккаунте раньше в пайплайне (prepareAccount) —
            // пароль уже передан выше; если authSignIn всё равно просит его — это не
            // «код не пришёл», а отдельная ошибка, тот же путь setup_failed у вызывающего.
            throw new Error(`authSignIn requires password unexpectedly: ${result.error}`);
        }
        return { kind: "signed_in", sessionString: result.sessionString };
    } finally {
        // authSignIn сам закрывает свою сессию при успехе/ошибке — этот вызов на
        // такой случай не найдёт ничего в authSessions и не сделает ничего лишнего.
        // Реально нужен для ветки code_timeout: без него клиент authSendCode
        // остаётся подключённым, его _updateLoop ретраит бесконечно (видели в
        // логах — Not connected/TIMEOUT спамом после первого прогона).
        await tg.abortAuthSession(phoneNumber);
    }
}
