// features/agent-reauth-sweep/run.ts — суточный кросс-агентный свип автоматической
// реавторизации агентов, застрявших под ограничением need_update_session
// (change auto-reauth-sweep).
//
// Кросс-агентная задача (не per-agent): берёт всех агентов с активным
// need_update_session из общей agent_restrictions и последовательно реавторизует
// каждого через существующую reauthFromTdata (tdata-сессия агента). Логика
// оркестрации; сама реавторизация и снятие ограничения при успехе — в reauthFromTdata.
//
// reauth-sweep-proxy-repair: на исходе connect_failed (мёртвый прокси) свип, прежде
// чем оставить агента транзиентным, пытается подобрать новый рабочий прокси через
// tdata (provisionProxyViaTdata) и повторить реавторизацию. Лимиты: до 10 кандидатов
// на агента, не более 5 агентов с автозаменой за прогон.

import type { Logger } from "../../core/logger";
import { listActiveByType, upsertRestriction } from "../../core/db/agent-restrictions";
import { loadAccountConfig } from "../../core/config";
import { classifyAccountError } from "../../core/telegram/errors";
import { reauthFromTdata, type ReauthFromTdataOutcome } from "../tg-agent-reauth-from-tdata/run";
import { parseProxyCountry } from "../proxy/provision-shared";
import { provisionProxyViaTdata } from "../proxy/provision-via-tdata";

/** Максимум агентов, которым свип пытается заменить прокси за один прогон (бюджет времени). */
const MAX_PROXY_REPAIRS_PER_RUN = 5;
/** Максимум кандидатов-прокси, проверяемых на одного агента за попытку замены. */
const PROXY_REPAIR_MAX_CANDIDATES = 10;

export interface ReauthSweepSummary {
    /** Всего агентов с need_update_session в выборке. */
    total: number;
    /** Реавторизованы (ограничение снято). */
    done: number;
    /** Уведены в manual_reauth (tdata_missing / password_rejected). */
    manualReauth: number;
    /** Переведены в banned (ошибка распознана как бан). */
    banned: number;
    /** Транзиентные (connect_failed / code_timeout / небановая error) — строку не трогали. */
    transient: number;
    /** agent_not_found — строку не трогали, аномалия для разбора по логам. */
    notFound: number;
    /** Агентов, которым за прогон заменён прокси (автозамена, reauth-sweep-proxy-repair). */
    proxyReplaced: number;
}

export async function runReauthSweep(log: Logger, adminAgentId: string): Promise<ReauthSweepSummary> {
    const stuck = listActiveByType(adminAgentId, "need_update_session");
    const summary: ReauthSweepSummary = {
        total: stuck.length, done: 0, manualReauth: 0, banned: 0, transient: 0, notFound: 0, proxyReplaced: 0,
    };
    let proxyRepairsThisRun = 0;

    log.info(`[agent-reauth-sweep] start — ${stuck.length} agent(s) with need_update_session`);

    // Применяет к строке agent_restrictions действие по исходу reauthFromTdata.
    // allowRepair=true — исходный вызов (connect_failed может запустить автозамену
    // прокси); allowRepair=false — повтор после замены (второй connect_failed уже не
    // запускает замену, чтобы не зациклиться и не тратить бюджет повторно).
    const applyOutcome = async (agentId: string, outcome: ReauthFromTdataOutcome, allowRepair: boolean): Promise<void> => {
        switch (outcome.kind) {
            case "done":
                // Снятие ограничения делает сама reauthFromTdata (clearRestriction).
                summary.done++;
                log.info(`[agent-reauth-sweep] ${agentId}: done — реавторизован, ограничение снято`);
                break;

            case "tdata_missing":
                upsertRestriction(adminAgentId, agentId, "manual_reauth", `нет tdata: ${outcome.path}`, null);
                summary.manualReauth++;
                log.info(`[agent-reauth-sweep] ${agentId}: tdata_missing → manual_reauth`);
                break;

            case "password_rejected":
                upsertRestriction(adminAgentId, agentId, "manual_reauth", "дефолтный 2FA-пароль не подошёл", null);
                summary.manualReauth++;
                log.info(`[agent-reauth-sweep] ${agentId}: password_rejected → manual_reauth`);
                break;

            case "error": {
                // outcome.error — строка; classifyAccountError читает .message, поэтому
                // оборачиваем. Только бан-сигнатура переводит в banned; иначе — транзиент.
                if (classifyAccountError({ message: outcome.error }) === "banned") {
                    upsertRestriction(adminAgentId, agentId, "banned", outcome.error, null);
                    summary.banned++;
                    log.warn(`[agent-reauth-sweep] ${agentId}: error распознан как бан → banned (${outcome.error})`);
                } else {
                    summary.transient++;
                    log.warn(`[agent-reauth-sweep] ${agentId}: error (не бан) — оставлен need_update_session, ретрай завтра (${outcome.error})`);
                }
                break;
            }

            case "connect_failed": {
                // Прокси не отвечает. Прежде чем оставить транзиентным — попытка
                // автозамены прокси через tdata и повтор реавторизации (только на
                // исходном вызове, не на повторе; reauth-sweep-proxy-repair).
                if (!allowRepair) {
                    summary.transient++;
                    log.warn(`[agent-reauth-sweep] ${agentId}: connect_failed на повторе — оставлен need_update_session, ретрай завтра`);
                    break;
                }
                if (proxyRepairsThisRun >= MAX_PROXY_REPAIRS_PER_RUN) {
                    summary.transient++;
                    log.warn(`[agent-reauth-sweep] ${agentId}: connect_failed, но лимит автозамен за прогон (${MAX_PROXY_REPAIRS_PER_RUN}) исчерпан — транзиент, ретрай завтра`);
                    break;
                }
                const account = loadAccountConfig(agentId);
                const country = parseProxyCountry(account.proxy?.username, account.proxy?.countryCode);
                if (!country) {
                    summary.transient++;
                    log.warn(`[agent-reauth-sweep] ${agentId}: connect_failed, но страну для подбора прокси определить нельзя — замена пропущена, транзиент`);
                    break;
                }
                proxyRepairsThisRun++;
                log.info(`[agent-reauth-sweep] ${agentId}: connect_failed — попытка автозамены прокси (страна ${country}, до ${PROXY_REPAIR_MAX_CANDIDATES} кандидатов)`);
                const proxy = await provisionProxyViaTdata(agentId, country, PROXY_REPAIR_MAX_CANDIDATES, log);
                if (proxy) {
                    summary.proxyReplaced++;
                    log.info(`[agent-reauth-sweep] ${agentId}: прокси заменён на ${proxy.host}:${proxy.port} — повтор реавторизации`);
                    const retry = await reauthFromTdata(agentId, undefined, log);
                    await applyOutcome(agentId, retry, false);
                } else {
                    summary.transient++;
                    log.warn(`[agent-reauth-sweep] ${agentId}: рабочий прокси не найден — оставлен need_update_session, ретрай завтра`);
                }
                break;
            }

            case "code_timeout":
                // Прокси живой (bootstrap подключился), код не прошёл — замену НЕ
                // запускаем. Транзиентно: строку не трогаем, ретрай на след. прогоне.
                summary.transient++;
                log.warn(`[agent-reauth-sweep] ${agentId}: code_timeout — оставлен need_update_session, ретрай завтра`);
                break;

            case "agent_not_found":
                // Аномалия: агент в таблице ограничений, но tg-account.json нет. Строку не трогаем.
                summary.notFound++;
                log.error(`[agent-reauth-sweep] ${agentId}: agent_not_found — строка ограничения оставлена без изменений (аномалия)`);
                break;
        }
    };

    for (const row of stuck) {
        const agentId = row.agentId;
        try {
            // 2FA по умолчанию (undefined) — reauthFromTdata возьмёт пароль шаблона персоны.
            const outcome = await reauthFromTdata(agentId, undefined, log);
            await applyOutcome(agentId, outcome, true);
        } catch (err: any) {
            // Изоляция: сбой одного агента не останавливает свип. Строку не трогаем.
            summary.transient++;
            log.error(`[agent-reauth-sweep] ${agentId}: непредвиденная ошибка — ${err?.message ?? err}`);
        }
    }

    log.info(
        `[agent-reauth-sweep] done — total=${summary.total} done=${summary.done} ` +
            `manual_reauth=${summary.manualReauth} banned=${summary.banned} transient=${summary.transient} ` +
            `not_found=${summary.notFound} proxy_replaced=${summary.proxyReplaced}`,
    );
    return summary;
}
