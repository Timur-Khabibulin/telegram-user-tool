// features/persona-apply/apply-persona.ts — общий шаг «применить персону сессией
// агента» (tg-agent-pool-provisioning). Единый код для двух потребителей пула:
// развёртывания персоны (фаза 2) и авто-замены забаненных. Тело — бывшие шаги 1–2
// из banned-account-replacement/run.ts:activateAndFinalize, вынесенные без изменения
// поведения (профиль/фото/username/публичный канал + инвайт-ссылка).

import type { Logger } from "../../core/logger";
import { REPORT_AGENT_ID, FUNNEL_ADMIN_AGENT_ID } from "../../core/config";
import { TelegramService } from "../../core/telegram/service";
import { setupReplacementAccount } from "../../core/tdata";
import { getPrivateInviteLink, upsertPrivateInviteLink, markPostUpdated } from "../../core/db/private-invites";
import { loadPersonaTemplate } from "../tg-agent-autoregistration/persona-template";

/**
 * Применяет персону к уже подготовленному аккаунту через ЕГО агентскую сессию
 * (не bootstrap): профиль/имя/био, все фото, `username`, публичный канал персоны с
 * постом, в который СРАЗУ вставлена персональная инвайт-ссылка в общий приватный канал
 * воронки (от `REPORT_AGENT_ID`).
 *
 * Порядок: инвайт-ссылка генерируется ДО создания поста, чтобы попасть в него сразу
 * (иначе — fallback на статичную ссылку из post.txt, а реестр не трогается: пост
 * позже перепубликует private-invite-links).
 *
 * @param connectId  id, под которым подключаемся к самому аккаунту. Для замены
 *                   забаненного равен `agentId` (аккаунт уже в `workspace-<agentId>`),
 *                   для фазы 2 — транзиентный `agent<N>.incoming` (промоушен последним).
 * @param agentId    логический id агента — title инвайт-ссылки и ключ реестра
 *                   `private_invite_links`.
 * @param username   уже сгенерированный username (nick+суффикс) — тот же, что записан
 *                   в `tg-account.json` (идемпотентность повторного применения).
 * @param inviteService  опционально: уже загруженный на `REPORT_AGENT_ID` сервис с
 *                   открытым соединением, переиспользуемый на всю пачку (фаза 2), чтобы
 *                   не переподключать agent27 на каждого агента. Если не передан —
 *                   соединение открывается и закрывается локально (одиночная замена).
 *
 * НЕ трогает 2FA и чужие сессии (сделано при создании пул-аккаунта, фаза 1).
 * Идемпотентна: профиль применяется повторно безопасно, публичный канал — под guard
 * «канал уже есть» внутри setupReplacementAccount, инвайт-ссылка — upsert.
 */
export async function applyPersonaToAccount(
    connectId: string,
    agentId: string,
    persona: string,
    username: string,
    log: Logger,
    inviteService?: TelegramService,
): Promise<void> {
    const template = loadPersonaTemplate(persona, true);

    // 1. Инвайт-ссылка в приватный канал воронки ПЕРСОНЫ — от REPORT_AGENT_ID (единый
    //    админ всех каналов, Модель A), ДО создания поста, чтобы вставить её сразу.
    //    Идемпотентно: если у агента уже есть ссылка в реестре — переиспользуем её (не
    //    плодим новые request-needed ссылки при повторных прогонах), иначе создаём и
    //    сохраняем. Нет funnelPrivateChannelId или создать не удалось → fallback: пост
    //    со статичной ссылкой из post.txt.
    const funnelChannelId = template.profileData.funnelPrivateChannelId;
    let inviteLink: string | null = getPrivateInviteLink(FUNNEL_ADMIN_AGENT_ID, agentId);
    if (inviteLink) {
        log.info(`[apply-persona] ${agentId}: переиспользую существующую инвайт-ссылку из реестра`);
    } else if (!funnelChannelId) {
        log.warn(`[apply-persona] ${agentId}: у персоны "${persona}" не задан funnelPrivateChannelId — пост со статичной ссылкой из post.txt`);
    } else {
        const ownService = inviteService ? null : new TelegramService(log);
        const svc = inviteService ?? ownService!;
        try {
            if (ownService) ownService.loadAccount(REPORT_AGENT_ID);
            const { link } = await svc.exportChatInvite(funnelChannelId, { title: agentId });
            inviteLink = link;
            upsertPrivateInviteLink(FUNNEL_ADMIN_AGENT_ID, agentId, link, Math.floor(Date.now() / 1000));
            log.info(`[apply-persona] ${agentId}: создана новая инвайт-ссылка`);
        } catch (err: any) {
            log.warn(`[apply-persona] ${agentId}: не удалось создать инвайт-ссылку (${err?.message ?? err}) — fallback на статичную ссылку из post.txt`);
        } finally {
            if (ownService) await ownService.disconnectAgent(REPORT_AGENT_ID).catch(() => {});
        }
    }

    // 2. Профиль/фото/username/публичный канал — сессией самого агента. Персональная
    //    ссылка (если получена) уже подставляется в пост при его создании.
    const tg = new TelegramService(log);
    try {
        tg.loadAccount(connectId);
        await tg.withActiveClient((client) =>
            setupReplacementAccount(client, template, username, log, inviteLink ?? undefined),
        );
    } finally {
        await tg.disconnectAgent(connectId).catch(() => {});
    }

    // 3. Ссылка (реиспользованная или созданная выше) уже вставлена в пост при его
    //    создании → отмечаем post_updated=1 (перепубликация private-invite-links не нужна).
    //    При fallback (ссылки нет) реестр не трогаем — агент подхватит private-invite-links
    //    отдельным прогоном.
    if (inviteLink) {
        markPostUpdated(FUNNEL_ADMIN_AGENT_ID, agentId);
        log.info(`[apply-persona] ${agentId}: инвайт-ссылка вставлена в пост при создании (post_updated=1)`);
    }
}
