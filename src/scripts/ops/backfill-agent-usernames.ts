// scripts/ops/backfill-agent-usernames.ts — разовый бэкфилл AccountConfig.username для уже
// существующих агентов (созданных до появления поля, или не через tg-agent-autoregistration).
//
// Источник истины — реальный Telegram-аккаунт (TelegramService.getSelfUsername, GetMe), не
// генерация: агент мог получить username любым путём (autoregistration, ручное создание,
// смена вручную) — читаем то, что реально стоит сейчас. Ограниченные агенты
// (agent-restrictions.db) НЕ пропускаются — getMe() не пишет ничего в Telegram, безопасно
// читать даже у забаненных диспетчером аккаунтов (подтверждено на agent1799,
// mobile-proxy-unique-exit-ip, 2026-08-26).
//
// Идемпотентен: агент с уже записанным `username` пропускается, если не передан --force.
// Обрабатывает агентов СТРОГО ПОСЛЕДОВАТЕЛЬНО (тот же принцип, что во всех остальных
// многоагентных скриптах платформы — не перегружать VPS одновременными MTProto-хендшейками).
//
// Запуск:
//   tsx backfill-agent-usernames.ts [--agents agent1,agent2,...] [--force]
// Без --agents — обходит всех агентов (listAgentIds()).

import * as fs from "fs";

import type { Logger } from "../../core/logger";
import { TelegramService } from "../../core/telegram/service";
import { accountConfigPath, listAgentIds, loadAccountConfig } from "../../core/config";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

function parseArg(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const val = argv[idx + 1];
    if (!val || val.startsWith("--")) return undefined;
    return val;
}

function saveUsernameToAccountConfig(agentId: string, username: string): void {
    const filePath = accountConfigPath(agentId);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    raw.username = username;
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

interface AgentResult {
    agentId: string;
    status: "updated" | "skipped_has_username" | "no_username_on_telegram" | "error";
    username?: string;
    detail?: string;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const agentsArg = parseArg(argv, "--agents");
    const force = argv.includes("--force");

    const agentIds = agentsArg
        ? agentsArg.split(",").map((s) => s.trim()).filter(Boolean)
        : listAgentIds();

    const tg = new TelegramService(log);
    const results: AgentResult[] = [];

    for (const agentId of agentIds) {
        if (!force) {
            try {
                const existing = loadAccountConfig(agentId).username;
                if (existing) {
                    results.push({ agentId, status: "skipped_has_username", username: existing });
                    continue;
                }
            } catch (err: any) {
                results.push({ agentId, status: "error", detail: `не удалось прочитать tg-account.json: ${err.message ?? err}` });
                continue;
            }
        }

        try {
            tg.loadAccount(agentId);
            const username = await tg.getSelfUsername();
            if (!username) {
                results.push({ agentId, status: "no_username_on_telegram" });
                continue;
            }
            saveUsernameToAccountConfig(agentId, username);
            log.info(`[backfill-username] ${agentId} — @${username}`);
            results.push({ agentId, status: "updated", username });
        } catch (err: any) {
            log.warn(`[backfill-username] ${agentId} — ошибка: ${err.message ?? err}`);
            results.push({ agentId, status: "error", detail: err.message ?? String(err) });
        } finally {
            await tg.disconnect().catch(() => {});
        }
    }

    log.info("");
    log.info("=== Итог ===");
    for (const r of results) {
        if (r.status === "updated") {
            log.info(`${r.agentId} — записано: @${r.username}`);
        } else if (r.status === "skipped_has_username") {
            log.info(`${r.agentId} — пропущен, уже есть username (@${r.username})`);
        } else if (r.status === "no_username_on_telegram") {
            log.info(`${r.agentId} — у аккаунта нет username на Telegram`);
        } else {
            log.info(`${r.agentId} — ошибка: ${r.detail}`);
        }
    }
}

main().catch((err) => {
    log.error(`[backfill-agent-usernames] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
