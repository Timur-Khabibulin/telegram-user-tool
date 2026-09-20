// features/private-invite-links/run.ts — персональные инвайт-ссылки в приватный канал
// и вставка их в закреплённый пост агента (change detached-reauth-and-invite-links).
//
// Логика извлечена из тула tg_private_invite_links (index.ts) в чистую функцию, чтобы
// её могли одинаково вызывать и plugin-тул (обёртка в index.ts), и ops-скрипт
// (src/scripts/ops/private-invite-links.ts, detached-запуск вне watchdog хода агента).
// Три режима: обычный (создать+вставить), retryPendingOnly (повтор вставки), verifyOnly
// (проверка соответствия). Список агентов передаёт вызывающий — не бэкфилл по флоту.

import type { Logger } from "../../core/logger";
import type { TelegramService } from "../../core/telegram/service";
import { FUNNEL_ADMIN_AGENT_ID, FUNNEL_PRIVATE_CHANNEL_ID, REPORT_AGENT_ID } from "../../core/config";
import {
    upsertPrivateInviteLink,
    markPostUpdated,
    listPendingPostUpdates,
    listPrivateInviteLinks,
} from "../../core/db/private-invites";

export interface PrivateInviteLinksParams {
    agentIds?: string[];
    retryPendingOnly?: boolean;
    verifyOnly?: boolean;
}

/** Результат режима verifyOnly. */
export interface VerifyResult {
    text: string;
    matched: string[];
    mismatched: Record<string, { dbLink: string; postLinks: string[] }>;
    verifyErrors: Record<string, string>;
}

/** Результат обычного режима и retryPendingOnly. */
export interface RunResult {
    text: string;
    created: Record<string, string>;
    inserted: string[];
    createErrors: Record<string, string>;
    insertSkipped: Record<string, string>;
}

export type PrivateInviteLinksResult = VerifyResult | RunResult;

export async function runPrivateInviteLinks(
    params: PrivateInviteLinksParams,
    tg: TelegramService,
    log: Logger,
): Promise<PrivateInviteLinksResult> {
    if (params.verifyOnly && params.retryPendingOnly) {
        throw new Error("verifyOnly и retryPendingOnly нельзя использовать одновременно");
    }

    if (params.verifyOnly) {
        const registry = listPrivateInviteLinks(FUNNEL_ADMIN_AGENT_ID);
        const targets = params.agentIds && params.agentIds.length > 0
            ? registry.filter((r) => params.agentIds!.includes(r.agentId))
            : registry;

        const matched: string[] = [];
        const mismatched: Record<string, { dbLink: string; postLinks: string[] }> = {};
        const verifyErrors: Record<string, string> = {};

        for (const row of targets) {
            try {
                tg.loadAccount(row.agentId);
                const res = await tg.getPersonalChannelPostLinks();
                if (!res.ok) {
                    verifyErrors[row.agentId] = res.reason;
                    log.warn(`[tg_private_invite_links] verify failed for agent=${row.agentId}: ${res.reason}`);
                    continue;
                }
                if (res.links.includes(row.inviteLink)) {
                    matched.push(row.agentId);
                } else {
                    mismatched[row.agentId] = { dbLink: row.inviteLink, postLinks: res.links };
                    log.warn(`[tg_private_invite_links] mismatch for agent=${row.agentId}: db=${row.inviteLink} post=${JSON.stringify(res.links)}`);
                }
            } catch (err: any) {
                const message = err.message ?? String(err);
                verifyErrors[row.agentId] = message;
                log.warn(`[tg_private_invite_links] verify error for agent=${row.agentId}: ${message}`);
            }
        }

        const lines: string[] = [
            `Проверено: ${targets.length}, совпадает: ${matched.length}, ` +
                `расхождение: ${Object.keys(mismatched).length}, ошибка: ${Object.keys(verifyErrors).length}`,
        ];
        if (Object.keys(mismatched).length > 0) {
            lines.push("Расхождения (ссылка в БД ≠ ссылка(и) в посте):");
            for (const [agentId, m] of Object.entries(mismatched)) {
                lines.push(`  ${agentId}: БД=${m.dbLink} пост=[${m.postLinks.join(", ") || "нет ссылок"}]`);
            }
        }
        if (Object.keys(verifyErrors).length > 0) {
            lines.push("Ошибки проверки:");
            for (const [agentId, err] of Object.entries(verifyErrors)) lines.push(`  ${agentId}: ${err}`);
        }

        return { text: lines.join("\n"), matched, mismatched, verifyErrors };
    }

    const { retryPendingOnly } = params;
    const now = Math.floor(Date.now() / 1000);
    const created: Record<string, string> = {};
    const createErrors: Record<string, string> = {};

    if (retryPendingOnly) {
        // Повтор: ссылки уже есть в реестре, шаг создания не выполняется.
        for (const row of listPendingPostUpdates(FUNNEL_ADMIN_AGENT_ID)) {
            created[row.agentId] = row.inviteLink;
        }
    } else {
        if (!params.agentIds || params.agentIds.length === 0) {
            throw new Error("agentIds обязателен, если retryPendingOnly не задан");
        }
        // Шаг 1 — создать ссылки от имени REPORT_AGENT_ID, сохранить под
        // FUNNEL_ADMIN_AGENT_ID (владелец платформенных данных).
        tg.loadAccount(REPORT_AGENT_ID);
        for (const agentId of params.agentIds) {
            try {
                const { link } = await tg.exportChatInvite(FUNNEL_PRIVATE_CHANNEL_ID, { title: agentId });
                upsertPrivateInviteLink(FUNNEL_ADMIN_AGENT_ID, agentId, link, now);
                created[agentId] = link;
                log.info(`[tg_private_invite_links] link created for agent=${agentId}: ${link}`);
            } catch (err: any) {
                const message = err.message ?? String(err);
                createErrors[agentId] = message;
                log.warn(`[tg_private_invite_links] link creation failed for agent=${agentId}: ${message}`);
            }
        }
    }

    // Шаг 2 — от имени каждого целевого агента вставить его ссылку в его
    // собственный пост. Общий для обоих режимов — created уже заполнен либо
    // свежесозданными, либо взятыми из реестра ссылками.
    const inserted: string[] = [];
    const insertSkipped: Record<string, string> = {};
    for (const agentId of Object.keys(created)) {
        try {
            tg.loadAccount(agentId);
            const res = await tg.updatePersonalChannelPostLink(created[agentId]);
            if (res.ok) {
                inserted.push(agentId);
                markPostUpdated(FUNNEL_ADMIN_AGENT_ID, agentId);
                log.info(`[tg_private_invite_links] post updated for agent=${agentId}`);
            } else {
                insertSkipped[agentId] = res.reason;
                log.warn(`[tg_private_invite_links] post not updated for agent=${agentId}: ${res.reason}`);
            }
        } catch (err: any) {
            const message = err.message ?? String(err);
            insertSkipped[agentId] = message;
            log.warn(`[tg_private_invite_links] post update failed for agent=${agentId}: ${message}`);
        }
    }

    const lines: string[] = [];
    if (retryPendingOnly) {
        lines.push(`Повтор для агентов с post_updated=0: ${Object.keys(created).length}`);
    } else {
        lines.push(`Ссылки созданы: ${Object.keys(created).length}/${params.agentIds!.length}`);
    }
    lines.push(`Вставлены в пост: ${inserted.length}/${Object.keys(created).length}`);
    if (Object.keys(createErrors).length > 0) {
        lines.push("Ошибки создания ссылки:");
        for (const [agentId, err] of Object.entries(createErrors)) lines.push(`  ${agentId}: ${err}`);
    }
    if (Object.keys(insertSkipped).length > 0) {
        lines.push("Не вставлено в пост (post_updated остаётся 0):");
        for (const [agentId, reason] of Object.entries(insertSkipped)) lines.push(`  ${agentId}: ${reason}`);
    }

    return { text: lines.join("\n"), created, inserted, createErrors, insertSkipped };
}
