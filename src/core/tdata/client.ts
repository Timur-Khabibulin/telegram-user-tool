// core/tdata/client.ts — tdata → рабочая MTProto-сессия (вариант A2, @mtcute/convert).
//
// Расшифровка формата tdata (официально не документирован) делегируется
// @mtcute/convert; сборка итоговой GramJS-сессии — тоже (convertToGramjsSession),
// сверено побайтово с node_modules/telegram/sessions/StringSession.js
// (docs/design/tg-agent-autoregistration/architecture.md §2.1). Версионный риск
// (парсер привязан к версии TDesktop, которой создан конкретный tdata) не закрыт
// чтением кода — координатор проверяет вручную на реальных архивах, не спайком в
// этом прогоне (см. openspec/changes/tg-agent-autoregistration/tasks.md, раздел 1).

import * as fs from "fs";
import * as path from "path";
import { convertFromTdata, convertToGramjsSession } from "@mtcute/convert";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { ConnectionTCPObfuscated } from "telegram/network/connection/TCPObfuscated";
import { NewMessage, type NewMessageEvent } from "telegram/events";
import type { Logger } from "../logger";
import type { ProxyConfig, DeviceConfig } from "../config";
import { TdataConnectError } from "./errors";

function buildProxyOptions(proxy: ProxyConfig) {
    const socksType: 5 | 4 = proxy.type === "socks5" ? 5 : 4;
    return {
        proxy: {
            socksType,
            ip: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
            timeout: 10,
        },
    };
}

export interface TdataAccountInfo {
    phoneNumber: string;
    currentPassword: string;
}

/**
 * phoneNumber из tdata/Accounts.txt, currentPassword из tdata/Password2FA.txt.
 * Используется `tg-agent-reauth-from-tdata`. Для `tg-agent-autoregistration`
 * телефон берётся из аккаунта (`readAccountPhone`), а 2FA — параметром прогона
 * (design D5), поэтому там эти сайдкары не читаются.
 */
export function readTdataAccountInfo(tdataPath: string): TdataAccountInfo {
    const phoneNumber = fs.readFileSync(path.join(tdataPath, "Accounts.txt"), "utf-8").trim();
    const currentPassword = fs.readFileSync(path.join(tdataPath, "Password2FA.txt"), "utf-8").trim();
    if (!phoneNumber) throw new Error(`tdata/Accounts.txt пуст: ${tdataPath}`);
    if (!currentPassword) throw new Error(`tdata/Password2FA.txt пуст: ${tdataPath}`);
    return { phoneNumber, currentPassword };
}

/**
 * Номер телефона аккаунта — из самого аккаунта через getMe() на подключённой
 * bootstrap-сессии (design D5, для tg-agent-autoregistration). getMe() для self
 * всегда содержит phone; пустое значение — аномалия, явная ошибка.
 */
export async function readAccountPhone(client: TelegramClient): Promise<string> {
    const me = await client.getMe();
    const phone = (me as any)?.phone as string | undefined;
    if (!phone) throw new Error("getMe() не вернул номер телефона аккаунта");
    return phone;
}

/**
 * Подключается к bootstrap-сессии, расшифровывая tdata через @mtcute/convert
 * (вариант A2). Без TDesktop passcode — подтверждено координатором для
 * закупленных аккаунтов; `ignoreVersion` по умолчанию выключен (architecture.md
 * §2.1) — если реальные архивы окажутся другой версии TDesktop, лучше явная
 * ошибка здесь, чем молчаливый мусорный authKey. Вызывающая сторона может
 * включить `ignoreVersion` явно, если версия формата уже проверена на реальных
 * архивах (openspec/changes/tg-agent-reauth-from-tdata — @mtcute/convert 0.31.0
 * поддерживает tdata только до версии формата 5008003 (TDesktop ~5.8.3), новее
 * не выпускалось; на архивах TDesktop 6.9.3/7.0.x с `ignoreVersion: true`
 * подтверждено рабочим на 19 реальных аккаунтах — единственный сбой был
 * `AUTH_KEY_UNREGISTERED`, то есть уже мёртвая сессия, а не порча ключа).
 */
/** Таймаут одной сетевой операции bootstrap-коннекта (connect/getMe). Тот же
 *  дефолт, что у ensureClient в core/telegram/service.ts. */
const CONNECT_TIMEOUT_MS = 60_000;

/** Гонит переданный промис с таймаутом: по истечении бросает, чтобы висящий
 *  GramJS-RPC не держал прогон бесконечно. */
function withTimeout<T>(op: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs),
    );
    return Promise.race([op, timeout]);
}

export async function connectBootstrap(
    tdataPath: string,
    proxy: ProxyConfig,
    apiId: number,
    apiHash: string,
    device: DeviceConfig | undefined,
    log: Logger,
    ignoreVersion = false,
): Promise<TelegramClient> {
    let sessionString: string;
    try {
        const data = await convertFromTdata({ path: tdataPath, ignoreVersion });
        sessionString = convertToGramjsSession(data);
    } catch (err: any) {
        throw new TdataConnectError(`не удалось расшифровать tdata (${tdataPath}): ${err.message ?? err}`, err);
    }

    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 1,
        autoReconnect: false,
        deviceModel:    device?.deviceModel,
        systemVersion:  device?.systemVersion,
        appVersion:     device?.appVersion,
        langCode:       device?.langCode       ?? "ru",
        systemLangCode: device?.systemLangCode ?? "ru",
        connection: ConnectionTCPObfuscated,
        useWSS: false,
        ...buildProxyOptions(proxy),
    });

    try {
        // И connect(), и getMe() гоняются с таймаутом: у «полуоткрытого» прокси
        // TCP-коннект проходит, но RPC не отвечает, а GramJS уходит в бесконечный
        // внутренний reconnect и голый await виснет навсегда. Таймаут бросает
        // наружу → selectWorkingProxy берёт следующий кандидат (maxProxyAttempts),
        // исчерпав — proxy_failed.
        await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, "connect");
        // getMe() — минимальная проверка, что сессия реально авторизована через
        // этот прокси, не просто TCP-коннект прошёл (симметрично ensureClient в
        // core/telegram/service.ts).
        await withTimeout(client.getMe(), CONNECT_TIMEOUT_MS, "getMe");
        log.info(`[tdata] connectBootstrap — подключено через ${proxy.host}:${proxy.port}`);
        return client;
    } catch (err: any) {
        await client.disconnect().catch(() => {});
        throw new TdataConnectError(`connect не удался (${proxy.host}:${proxy.port}): ${err.message ?? err}`, err);
    }
}

const TELEGRAM_SERVICE_PEER_ID = BigInt(777000);

function extractCode(text: string): string | null {
    const match = text.match(/\d{5,}/);
    return match ? match[0] : null;
}

/**
 * Ждёт входящий код авторизации второй (агентской) сессии на уже залогиненном
 * bootstrap-соединении (R-D5: фиксированный таймаут). Код приходит служебным
 * сообщением от peer 777000 ("Telegram" — тот же id, что уже используется в
 * core/telegram/service.ts:getDmDialogs для его фильтрации); текст парсится на
 * первую последовательность из 5+ цифр.
 *
 * Живой прогон (retryManualCode, agent220) показал: bootstrap-соединение рвётся
 * и переподключается по нескольку раз за 2-минутное окно (нестабильность
 * мобильного прокси) — GramJS при реконнекте не гарантированно догоняет
 * пропущенные во время разрыва апдейты, из-за чего push-событие может быть
 * потеряно даже когда Telegram доставил код вовремя. Поэтому событие — не
 * единственный источник: параллельно каждые 5 секунд опрашивается история
 * чата 777000 напрямую (`getMessages`), не завися от непрерывности push-потока.
 * Побеждает тот источник, что поймал код раньше; при ошибке одного опроса
 * (например, клиент как раз посреди реконнекта) — не фатально, следующий
 * опрос или событие всё ещё могут сработать.
 */
export async function readIncomingCode(client: TelegramClient, timeoutMs: number, log: Logger): Promise<string | null> {
    const eventBuilder = new NewMessage({ fromUsers: ["777000"], incoming: true });
    const diagBuilder = new NewMessage({ incoming: true });

    let eventResolve!: (v: string | null) => void;
    const eventPromise = new Promise<string | null>((resolve) => {
        eventResolve = resolve;
    });

    const diagHandler = (event: NewMessageEvent) => {
        const snippet = (event.message.text ?? "").slice(0, 80);
        log.info(`[tdata] readIncomingCode — диагностика: сообщение от senderId=${event.message.senderId?.toString()} text="${snippet}"`);
    };
    const handler = (event: NewMessageEvent) => {
        const code = extractCode(event.message.text ?? "");
        if (code) eventResolve(code);
    };
    client.addEventHandler(handler, eventBuilder);
    client.addEventHandler(diagHandler, diagBuilder);

    const POLL_INTERVAL_MS = 5_000;
    const deadline = Date.now() + timeoutMs;
    const pollLoop = async (): Promise<string | null> => {
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            try {
                const messages = await client.getMessages(TELEGRAM_SERVICE_PEER_ID, { limit: 5 });
                for (const m of messages as any[]) {
                    const code = extractCode(m.text ?? m.message ?? "");
                    if (code) return code;
                }
            } catch (err: any) {
                log.warn(`[tdata] readIncomingCode — опрос истории 777000 не удался (не фатально): ${err.message ?? err}`);
            }
        }
        return null;
    };

    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));

    const result = await Promise.race([eventPromise, pollLoop(), timeoutPromise]);

    client.removeEventHandler(handler, eventBuilder);
    client.removeEventHandler(diagHandler, diagBuilder);

    return result;
}
