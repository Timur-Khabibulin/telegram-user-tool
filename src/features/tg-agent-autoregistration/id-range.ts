// features/tg-agent-autoregistration/id-range.ts — проверка диапазона agentId (R-8, R-11).

import { listAgentIds } from "../../core/config";
import { listStagingAgentIds } from "./staging";

/** N = число ссылок в megaLinks; agentId по порядку — <prefix>startAgentNumber..+N-1 (R-11). */
export function computeAgentIdRange(startAgentNumber: number, megaLinksCount: number): string[] {
    return Array.from({ length: megaLinksCount }, (_, i) => `agent${startAgentNumber + i}`);
}

export interface RangeCheckResult {
    ok: boolean;
    conflicts: string[];
}

/** R-8: диапазон не должен пересекаться с существующими агентами или стейджингом прошлого прогона. */
export function checkAgentIdRangeFree(agentIds: string[]): RangeCheckResult {
    const existing = new Set([...listAgentIds(), ...listStagingAgentIds()]);
    const conflicts = agentIds.filter((id) => existing.has(id));
    return { ok: conflicts.length === 0, conflicts };
}
