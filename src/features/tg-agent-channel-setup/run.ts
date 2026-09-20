// features/tg-agent-channel-setup/run.ts — batch-создание публичного канала персоны
// для уже зарегистрированных агентов (change tg-autoreg-optional-channel-and-setup-skill).
//
// Отдельный от реги шаг: подключается ЧЕРЕЗ СЕССИЮ агента (не bootstrap tdata),
// персону и username читает из tg-account.json, переиспользует createPersonaChannel.
// Guard: агенты с уже установленным personal-каналом пропускаются (design D3) —
// повторный прогон на пачке безопасен, дублей и CHANNELS_ADMIN_PUBLIC_TOO_MUCH нет.
// Per-agent изоляция: ошибка/скип одного не останавливает пачку.

import type { Logger } from "../../core/logger";
import { TelegramService } from "../../core/telegram/service";
import { loadAccountConfig } from "../../core/config";
import { createPersonaChannel } from "../../core/tdata";
import { loadPersonaTemplate } from "../tg-agent-autoregistration/persona-template";

export interface ChannelSetupResult {
    agentId: string;
    status: "done" | "skipped" | "failed";
    error?: string;
}

export interface ChannelSetupReport {
    results: ChannelSetupResult[];
}

export async function runChannelSetup(agentIds: string[], log: Logger): Promise<ChannelSetupReport> {
    const results: ChannelSetupResult[] = [];
    for (const agentId of agentIds) {
        const tg = new TelegramService(log);
        try {
            tg.loadAccount(agentId);
            const cfg = loadAccountConfig(agentId);
            const username = cfg.username;
            if (!username) {
                throw new Error(`у агента ${agentId} нет username в tg-account.json — канал не создать`);
            }
            const template = loadPersonaTemplate(cfg.persona, true);

            // Guard (D3): у агента уже есть personal-канал — не пересоздаём.
            const existing = await tg.getOwnPersonalChannel();
            if (existing) {
                log.info(`[tg-agent-channel-setup] ${agentId} — personal-канал уже есть (${existing.title}), skip`);
                results.push({ agentId, status: "skipped" });
                continue;
            }

            await tg.withActiveClient((client) => createPersonaChannel(client, template, username, log));
            results.push({ agentId, status: "done" });
        } catch (err: any) {
            log.error(`[tg-agent-channel-setup] ${agentId} — ошибка: ${err.message ?? err}`);
            results.push({ agentId, status: "failed", error: err.message ?? String(err) });
        } finally {
            await tg.disconnectAgent(agentId).catch(() => {});
        }
    }
    return { results };
}

export function renderChannelSetupReport(report: ChannelSetupReport): string {
    const lines = report.results.map((r) => `  ${r.agentId}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
    const summary = report.results.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
    }, {});
    return [
        `tg-agent-channel-setup — ${report.results.length} account(s)`,
        `Summary: ${JSON.stringify(summary)}`,
        ...lines,
    ].join("\n");
}
