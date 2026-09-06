// scripts/ops/channel-not-found-migration.ts — разовая миграция БД
// (channel-not-found-recovery), запускать ТОЛЬКО после деплоя кода self-heal
// (join.ts / channels.ts) — иначе cat7 (requeue) упрётся в старую ветку
// USER_ALREADY_PARTICIPANT → error и строки не восстановятся (design.md, Risks).
//
// Обходит агентов с включённым `monitor-v5` и чинит три категории мусора,
// накопленного старой логикой (DELETE в syncChannels, identity-only upsert
// при join):
//   cat4 — channels.status='leaved_manual', но join_queue.status='joined' для
//          того же канала выставлен ПОЗЖЕ — статус залип, канал реально снова
//          доступен → сброс status в NULL.
//   cat5 — channels.status='only_comment' без соответствующей 'joined'-записи
//          в join_queue → сброс status в NULL (остальные статусы cat5 —
//          should_leave/leaved_manual/banned — НЕ трогаются, см. design.md).
//   cat7 — join_queue.status='joined', но строки в channels.db для этого
//          канала нет (потеряна прежним DELETE) → join_queue.status='pending'
//          для повторного вступления через новую self-heal логику.
//
// Сопоставление канал↔join_queue — по username (channelUsername ИЛИ
// chatUsername), в пределах БД одного агента: в join_queue нет chatId.
//
// Запуск: tsx src/scripts/ops/channel-not-found-migration.ts [--dry-run]

import { listAgentIds } from "../../core/config";
import { listTasks } from "../../core/db/tasks";
import { getChannelsStatusInfo, resetChannelStatuses, type ChannelStatusInfoRow } from "../../core/db/channels";
import { getJoinedLinksWithTimestamps, requeueJoinedLinks, type JoinedLinkRow } from "../../core/db/join-queue";
import type { Logger } from "../../core/logger";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

/** username из ссылки join_queue ("https://t.me/<username>"), lowercase — для сопоставления с channelUsername/chatUsername. */
function usernameFromLink(link: string): string {
    return link
        .replace(/^https?:\/\//, "")
        .replace(/^(www\.)?(t\.me|telegram\.me)\//, "")
        .replace(/^@/, "")
        .split(/[/?#]/)[0]
        .trim()
        .toLowerCase();
}

function isMonitorV5Enabled(agentId: string): boolean {
    return listTasks(agentId).some((t) => t.type === "monitor-v5" && t.enabled === 1);
}

interface AgentResult {
    agentId: string;
    cat4: number;
    cat5: number;
    cat7: number;
}

function migrateAgent(agentId: string, dryRun: boolean): AgentResult {
    const channels: ChannelStatusInfoRow[] = getChannelsStatusInfo(agentId, log);
    const joined: JoinedLinkRow[] = getJoinedLinksWithTimestamps(agentId, log);

    // username -> самое позднее updatedAt среди joined-записей на этот username
    const joinedAtByUsername = new Map<string, number>();
    for (const { link, updatedAt } of joined) {
        const u = usernameFromLink(link);
        if (!u) continue;
        const prev = joinedAtByUsername.get(u);
        if (prev === undefined || updatedAt > prev) joinedAtByUsername.set(u, updatedAt);
    }

    // username'ы, уже покрытые строкой channels — для cat7 (обратное сопоставление).
    const channelUsernames = new Set<string>();
    for (const c of channels) {
        if (c.channelUsername) channelUsernames.add(c.channelUsername.toLowerCase());
        if (c.chatUsername) channelUsernames.add(c.chatUsername.toLowerCase());
    }

    const cat4ChatIds: string[] = [];
    const cat5ChatIds: string[] = [];

    for (const c of channels) {
        const joinedAt = (c.channelUsername && joinedAtByUsername.get(c.channelUsername.toLowerCase()))
            ?? (c.chatUsername && joinedAtByUsername.get(c.chatUsername.toLowerCase()))
            ?? undefined;

        if (c.status === "leaved_manual" && joinedAt !== undefined) {
            if (c.statusUpdatedAt === null || c.statusUpdatedAt < joinedAt) {
                cat4ChatIds.push(c.chatId);
            }
        } else if (c.status === "only_comment" && joinedAt === undefined) {
            cat5ChatIds.push(c.chatId);
        }
    }

    const cat7Links = joined
        .filter(({ link }) => !channelUsernames.has(usernameFromLink(link)))
        .map(({ link }) => link);

    if (dryRun) {
        log.info(`[channel-not-found-migration] ${agentId} (dry-run): cat4=${cat4ChatIds.length} cat5=${cat5ChatIds.length} cat7=${cat7Links.length}`);
        return { agentId, cat4: cat4ChatIds.length, cat5: cat5ChatIds.length, cat7: cat7Links.length };
    }

    const { reset: resetCount } = resetChannelStatuses(agentId, [...cat4ChatIds, ...cat5ChatIds], log);
    const { requeued } = requeueJoinedLinks(agentId, cat7Links, log);

    log.info(
        `[channel-not-found-migration] ${agentId}: cat4=${cat4ChatIds.length} cat5=${cat5ChatIds.length} ` +
            `(итого сброшено статусов=${resetCount}) cat7_requeued=${requeued}`,
    );
    return { agentId, cat4: cat4ChatIds.length, cat5: cat5ChatIds.length, cat7: requeued };
}

function main(): void {
    const dryRun = process.argv.includes("--dry-run");
    if (dryRun) log.info("[channel-not-found-migration] DRY RUN — изменения не записываются");

    const agents = listAgentIds().filter(isMonitorV5Enabled);
    log.info(`[channel-not-found-migration] агентов с monitor-v5: ${agents.length}`);

    const results: AgentResult[] = [];
    for (const agentId of agents) {
        try {
            results.push(migrateAgent(agentId, dryRun));
        } catch (err: any) {
            log.error(`[channel-not-found-migration] ${agentId}: сбой — ${err?.message ?? err}`);
        }
    }

    const totals = results.reduce(
        (acc, r) => ({ cat4: acc.cat4 + r.cat4, cat5: acc.cat5 + r.cat5, cat7: acc.cat7 + r.cat7 }),
        { cat4: 0, cat5: 0, cat7: 0 },
    );
    log.info(
        `[channel-not-found-migration] готово: агентов=${results.length} ` +
            `cat4=${totals.cat4} cat5=${totals.cat5} cat7=${totals.cat7} ` +
            `(целевой прирост активных ~${totals.cat4 + totals.cat5} сразу + до ${totals.cat7} после повторного join)`,
    );
}

main();
