// skills/channel-context.ts — runChannelContext (channel-context).
//
// Периодическая задача диспетчера: раз в 8 часов обрабатывает до BATCH_SIZE
// каналов агента, у которых channel_context никогда не строился или устарел
// (TTL 90 дней) — тонкая обёртка над core/channel-context/run.ts, использует
// уже загруженный/подключённый ctx.tg (сессией управляет диспетчер, не скилл).
// Spec: openspec/changes/channel-context/.

import type { SkillContext, SkillStatus } from "./types";
import { runChannelContextForAgent } from "../core/channel-context/run";

const BATCH_SIZE = 20;

export async function runChannelContext(ctx: SkillContext): Promise<SkillStatus> {
    const { agentId, tg, llm, log } = ctx;

    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { status: "error", details: { step: "load_account", error: err.message ?? String(err) } };
    }

    const result = await runChannelContextForAgent({ agentId, limit: BATCH_SIZE, tg, llm }, log);

    return {
        status: "success",
        details: {
            "каналов отобрано": result.channelsSelected,
            "проанализировано": result.channelsAnalyzed,
            "пропущено": result.skipped.length,
        },
    };
}
