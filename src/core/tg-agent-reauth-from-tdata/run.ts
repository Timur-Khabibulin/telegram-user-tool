// core/tg-agent-reauth-from-tdata/run.ts — реавторизация СУЩЕСТВУЮЩЕГО агента
// через уже имеющуюся у него tdata-сессию (openspec/changes/tg-agent-reauth-from-tdata).
//
// В отличие от tg-agent-autoregistration (создание НОВОГО агента), здесь НЕ вызывается
// prepareAccount — профиль, фото, публичные каналы и 2FA-пароль существующего агента не
// трогаются (design.md, Goals/Non-Goals). Переиспользуются как есть: connectBootstrap
// (tdata → авторизованное bootstrap-соединение) и registerAgenticSession (регистрация
// новой независимой MTProto-сессии, код авторизации перехватывается автоматически через
// bootstrap-соединение — оператор код не вводит).

import * as fs from "fs";
import * as path from "path";
import type { TelegramClient } from "telegram";

import type { Logger } from "../logger";
import { accountConfigPath, loadAccountConfig, tdataPath, FUNNEL_ADMIN_AGENT_ID } from "../config";
import { connectBootstrap, readTdataAccountInfo } from "../tdata";
import { registerAgenticSession } from "../tg-agent-autoregistration/agentic-session";
import { templatesDir } from "../tg-agent-autoregistration/persona-template";
import { clearRestriction } from "../db/agent-restrictions";

/** Шаблон персоны, чей 2FA-пароль пробуется по умолчанию (design.md D3) — единственный
 *  шаблон на платформе на момент этого change; агенты, о которых идёт речь (созданные
 *  до автогенерации), заводились под той же персоной. */
const DEFAULT_PASSWORD_TEMPLATE = "maria";

export type ReauthFromTdataOutcome =
    | { kind: "done"; accountId: string }
    | { kind: "agent_not_found"; agentId: string }
    | { kind: "tdata_missing"; path: string }
    | { kind: "connect_failed"; error: string }
    | { kind: "code_timeout" }
    | { kind: "password_rejected"; error: string }
    | { kind: "error"; error: string };

function readDefaultPassword2FA(): string {
    const p = path.join(templatesDir(DEFAULT_PASSWORD_TEMPLATE), "default_agent_data.json");
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return data["2fa"];
}

/** Перезаписывает ТОЛЬКО sessionString в существующем tg-account.json — остальные поля
 *  (accountId, apiId, apiHash, device, proxy) не трогаются (spec: "Only sessionString is
 *  overwritten"). Тот же приём, что Шаг 6 в skills/tg-agent-reauth/SKILL.md. */
function writeSessionString(agentId: string, sessionString: string): void {
    const p = accountConfigPath(agentId);
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    raw.sessionString = sessionString;
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), "utf-8");
}

/** `errorMessage`/`message` Telegram-ошибки неверного 2FA-пароля — отличаем от прочих
 *  ошибок регистрации сессии, чтобы вызывающая сторона могла запросить другой пароль
 *  вместо непонятной общей ошибки (spec: "2FA password with default, explicit override"). */
function isPasswordRejection(err: any): boolean {
    const code = err?.errorMessage ?? "";
    const message: string = err?.message ?? String(err);
    return code === "PASSWORD_HASH_INVALID" || message.includes("requires password unexpectedly");
}

export async function reauthFromTdata(
    agentId: string,
    password2fa: string | undefined,
    log: Logger,
): Promise<ReauthFromTdataOutcome> {
    let account;
    try {
        account = loadAccountConfig(agentId);
    } catch {
        return { kind: "agent_not_found", agentId };
    }
    if (!account.proxy) {
        return { kind: "error", error: `tg-account.json агента ${agentId} не содержит proxy` };
    }

    const tdata = tdataPath(agentId);
    if (!fs.existsSync(path.join(tdata, "Accounts.txt")) || !fs.existsSync(path.join(tdata, "Password2FA.txt"))) {
        return { kind: "tdata_missing", path: tdata };
    }

    const { phoneNumber } = readTdataAccountInfo(tdata);
    const resolvedPassword = password2fa ?? readDefaultPassword2FA();

    let bootstrapClient: TelegramClient;
    try {
        // ignoreVersion: true — эти агенты созданы до автогенерации, tdata часто
        // новее версии формата, которую понимает установленный @mtcute/convert
        // (0.31.0, поддерживает только до TDF-версии 5008003). Подтверждено
        // рабочим на 19 реальных аккаунтах (client.ts, connectBootstrap).
        bootstrapClient = await connectBootstrap(
            tdata,
            account.proxy,
            account.apiId,
            account.apiHash,
            account.device,
            log,
            true,
        );
    } catch (err: any) {
        return { kind: "connect_failed", error: err.message ?? String(err) };
    }

    try {
        const agentic = await registerAgenticSession(
            bootstrapClient,
            account.apiId,
            account.apiHash,
            phoneNumber,
            account.proxy,
            resolvedPassword,
            log,
        );
        if (agentic.kind === "code_timeout") {
            return { kind: "code_timeout" };
        }
        writeSessionString(agentId, agentic.sessionString);
        // Новая рабочая сессия сама по себе не снимает ограничение агента —
        // getActiveRestriction в dispatcher.ts продолжит пропускать агента с
        // need_update_session/banned, даже если сессия уже валидна. Снимаем явно.
        clearRestriction(FUNNEL_ADMIN_AGENT_ID, agentId);
        log.info(`[tg-agent-reauth-from-tdata] agent=${agentId} — реавторизован, новая sessionString записана, ограничение снято`);
        return { kind: "done", accountId: account.accountId };
    } catch (err: any) {
        if (isPasswordRejection(err)) {
            return { kind: "password_rejected", error: err.message ?? String(err) };
        }
        return { kind: "error", error: err.message ?? String(err) };
    } finally {
        // Локальный сокет закрываем всегда — это НЕ логаут: tdata-сессия остаётся
        // активной на стороне Telegram (design.md D4, тот же приём, что в
        // tg-agent-autoregistration processAccount).
        await bootstrapClient.disconnect().catch(() => {});
    }
}
