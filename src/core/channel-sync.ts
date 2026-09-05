// core/channel-sync.ts — наполнение кэша идентичности привязанных каналов.
//
// Резолвит привязанный broadcast-канал для непрорезолвленных чатов агента и кэширует
// идентичность в channels.db (channel-content-analysis). Один раз на чат, инкрементально:
// тяжёлый бэкафилл старых строк размазан по тикам синхронизации (монитор / tg_channels_sync),
// дальше резолвятся только новые чаты. Маппинг «обсуждение → канал» неизменен, поэтому
// повторного резолва нет.

import type { Logger } from "./logger";
import { TelegramService } from "./telegram/service";
import { FloodWaitError, ClientNotConnectedError } from "./telegram/errors";
import { getUnresolvedChats, saveChannelIdentity } from "./db/channels";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pacingMs = () => 800 + Math.random() * 400; // 0.8–1.2 c между резолвами

/**
 * Резолвит и кэширует идентичность привязанного канала для непрорезолвленных чатов
 * агента. `limit` размазывает разовый бэкафилл по тикам. Безопасна к сбоям: FLOOD_WAIT
 * прерывает добор (повтор на следующем тике), прочие ошибки оставляют чат
 * непрорезолвленным. Требует уже загруженной сессии и проинициализированной channels.db.
 */
export async function cacheChannelIdentities(
    agentId: string,
    tg: TelegramService,
    log: Logger,
    limit = 20,
): Promise<{ resolved: number }> {
    const unresolved = getUnresolvedChats(agentId, log, limit);
    if (unresolved.length === 0) return { resolved: 0 };

    const dialogChannels = await tg.listDialogChannels();
    const byChatId = new Map(dialogChannels.map((dc) => [dc.chatId, dc]));

    let resolved = 0;
    for (const chatId of unresolved) {
        const dc = byChatId.get(chatId);
        if (!dc) {
            // Чат не канал/мегагруппа (обычная группа) — привязанного канала нет.
            saveChannelIdentity(agentId, chatId, null, log);
            resolved += 1;
            continue;
        }
        try {
            const identity = await tg.resolveChannelIdentityForDialog(dc);
            saveChannelIdentity(agentId, chatId, identity, log);
            resolved += 1;
            await sleep(pacingMs());
        } catch (err) {
            if (err instanceof FloodWaitError) {
                log.warn(`[channel-sync] ${agentId}: резолв прерван FLOOD_WAIT — добьём на след. тике`);
                break;
            }
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[channel-sync] ${agentId}: резолв чата ${chatId} не удался: ${(err as any)?.message ?? err}`);
        }
    }
    log.info(`[channel-sync] ${agentId}: закэшировано идентичностей ${resolved}/${unresolved.length}`);
    return { resolved };
}
