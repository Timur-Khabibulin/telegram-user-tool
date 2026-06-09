// core/config.ts — конфигурация аккаунта и пути к данным агента.
//
// Загрузка `tg-account.json` и все пути к БД собраны здесь, чтобы один и тот же
// источник истины использовали и плагин OpenClaw, и диспетчер. Пути не меняются
// относительно прежней реализации — данные переносятся бесшовно (R-D2).

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface ProxyConfig {
    type: "socks5" | "socks4";
    host: string;
    port: number;
    username?: string;
    password?: string;
}

export interface DeviceConfig {
    deviceModel?: string;
    systemVersion?: string;
    appVersion?: string;
    langCode?: string;
    systemLangCode?: string;
}

export interface AccountConfig {
    accountId: string;
    apiId: number;
    apiHash: string;
    sessionString: string;
    device?: DeviceConfig;
    proxy?: ProxyConfig;
}

// ─── Пути к данным агента ─────────────────────────────────────────────

/** Рабочая папка агента: ~/.openclaw/workspace-<agentId>. */
export function workspaceDir(agentId: string): string {
    return path.join(os.homedir(), ".openclaw", `workspace-${agentId}`);
}

/**
 * Идентификаторы всех агентов — по каталогам ~/.openclaw/workspace-<agentId>.
 * workspace-каталоги — фактический источник истины об агентах (отдельный реестр
 * пришлось бы синхронизировать). Используется дневной сводкой (обход всех агентов).
 */
export function listAgentIds(): string[] {
    const base = path.join(os.homedir(), ".openclaw");
    const prefix = "workspace-";
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((e) => e.isDirectory() && e.name.startsWith(prefix) && e.name.length > prefix.length)
        .map((e) => e.name.slice(prefix.length));
}

export function accountConfigPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "tg-account.json");
}

export function channelsDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "tg-channels.db");
}

export function repliesDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "tg-replies.db");
}

export function dmThreadsDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "dm-threads.db");
}

export function joinQueueDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "tg-join-queue.db");
}

export function tasksDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "tasks.db");
}

/**
 * Путь к БД воронки (funnel-tracking). Лежит в workspace админ-агента
 * (по умолчанию agent1) — он же получатель отчёта. Отдельного «трекинг-агента»
 * не заводим: один скрипт пишет сюда снапшоты и дневные агрегаты.
 */
export function funnelDbPath(adminAgentId: string): string {
    return path.join(workspaceDir(adminAgentId), "funnel.db");
}

// ─── Конфигурация воронки (funnel-tracking) ───────────────────────────

/** Админ-агент: получатель отчёта-воронки и владелец funnel.db. */
export const FUNNEL_ADMIN_AGENT_ID = "agent1";

/**
 * ID приватного канала для подсчёта заявок на вступление (agent1 — админ).
 * Формат — как в get_dialogs / tg-channels.db (вид -100…). Захардкожен здесь
 * как единый источник истины: и инструмент tg_funnel_report, и скрипт-таймер
 * берут это значение (скрипт может переопределить аргументом --private-channel).
 */
export const FUNNEL_PRIVATE_CHANNEL_ID = "-1003698044714";

/**
 * Путь к SOUL.md агента — персона, передаётся LLM как `system` (R-E2).
 * Лежит в workspace агента: ~/.openclaw/workspace-<agentId>/SOUL.md — туда его
 * пишет скилл `tg-agent-create` (Шаг 6) и там он реально находится на сервере.
 * (Спека llm-layer называла путь agents/<name>/agent/SOUL.md — это расхождение с
 * фактическим размещением; источник истины — workspace, где файл создаётся.)
 * agentId === agentName (R-E1).
 */
export function soulPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "SOUL.md");
}

// ─── Загрузка конфигурации аккаунта ───────────────────────────────────

/**
 * Читает и валидирует `tg-account.json` агента. Бросает Error с человекочитаемым
 * сообщением при отсутствии обязательных полей — вызывающая сторона
 * (плагин или диспетчер) превращает его в свой формат ошибки.
 */
export function loadAccountConfig(agentId: string): AccountConfig {
    const configPath = accountConfigPath(agentId);
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);

    if (!cfg.apiId || !cfg.apiHash || !cfg.sessionString) {
        throw new Error("tg-account.json is missing required fields: apiId, apiHash, sessionString");
    }

    let proxy: ProxyConfig | undefined;
    if (cfg.proxy) {
        const { type, host, port, username, password } = cfg.proxy;
        if (!host || !port) {
            throw new Error("tg-account.json proxy is missing required fields: host, port");
        }
        proxy = {
            type: type === "socks4" ? "socks4" : "socks5",
            host: String(host),
            port: Number(port),
            username: username ? String(username) : undefined,
            password: password ? String(password) : undefined,
        };
    }

    let device: DeviceConfig | undefined;
    if (cfg.device && typeof cfg.device === "object") {
        const d = cfg.device;
        device = {
            deviceModel:    d.deviceModel    ? String(d.deviceModel)    : undefined,
            systemVersion:  d.systemVersion  ? String(d.systemVersion)  : undefined,
            appVersion:     d.appVersion     ? String(d.appVersion)     : undefined,
            langCode:       d.langCode       ? String(d.langCode)       : undefined,
            systemLangCode: d.systemLangCode ? String(d.systemLangCode) : undefined,
        };
    }

    return {
        accountId: cfg.accountId ?? "default",
        apiId: Number(cfg.apiId),
        apiHash: String(cfg.apiHash),
        sessionString: String(cfg.sessionString),
        device,
        proxy,
    };
}
