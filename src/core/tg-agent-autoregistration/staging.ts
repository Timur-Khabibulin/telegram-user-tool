// core/tg-agent-autoregistration/staging.ts — стейджинг вне workspace-* (R-7, R-D3, R-D4).
//
// До статуса done данные аккаунта живут здесь, не в workspace-<agentId>/ — сам факт
// существования workspace-* делает агента видимым для listAgentIds() и, соответственно,
// платформенным cron-скриптам (discovery/distribute-channels/distribute-pool/
// channel-coverage-update/backfill-schedule-defaults/join-queue-backfill), у которых
// для него ещё нет валидного tg-account.json.

import * as fs from "fs";
import * as path from "path";
import { workspaceDir, type AccountConfig } from "../config";
import { autoregistrationRoot } from "./persona-template";

export function stagingRoot(): string {
    return path.join(autoregistrationRoot(), "staging");
}

export function stagingDir(agentId: string): string {
    return path.join(stagingRoot(), agentId);
}

export function stagingTdataDir(agentId: string): string {
    return path.join(stagingDir(agentId), "tdata");
}

export type AccountStatus = "proxy_failed" | "setup_failed" | "needs_manual_code" | "done";

export interface StagingStatus {
    status: AccountStatus;
    error?: string;
    updatedAt: number;
}

function statusPath(agentId: string): string {
    return path.join(stagingDir(agentId), "status.json");
}

/** Атомарная запись status.json — tmp-файл + renameSync (R-D3), не прямой writeFileSync. */
export function writeStagingStatus(agentId: string, status: AccountStatus, error?: string): void {
    fs.mkdirSync(stagingDir(agentId), { recursive: true });
    const payload: StagingStatus = { status, error, updatedAt: Date.now() };
    const tmpPath = `${statusPath(agentId)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmpPath, statusPath(agentId));
}

export function readStagingStatus(agentId: string): StagingStatus | null {
    const p = statusPath(agentId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as StagingStatus;
}

/** agentId со всеми записями (любого статуса) в стейджинге прошлых прогонов (R-8/R-9). */
export function listStagingAgentIds(): string[] {
    const root = stagingRoot();
    if (!fs.existsSync(root)) return [];
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
}

/**
 * Атомарный перенос на done (R-D4): сначала в стейджинге собирается полное
 * содержимое итогового workspace (tdata/ уже там из скачивания — R-D2, добавляем
 * tg-account.json), затем один renameSync — атомарен на уровне ОС в
 * пределах одной файловой системы (architecture.md §3). После переноса
 * записи в стейджинге для этого agentId не существует.
 *
 * SOUL.md в workspace не пишется (agent-persona-template) — персона резолвится
 * рантаймом через поле `persona` в `accountConfig`, шаблон читается живьём из
 * ~/.openclaw/personas/<persona>/SOUL.md.
 *
 * `status.json` переезжает вместе с остальным содержимым папки (renameSync —
 * это перенос всей директории целиком, не только нового файла) — поэтому
 * перед переносом он явно перезаписывается на "done": иначе в workspace-agent<N>
 * остался бы устаревший статус из прошлой попытки (например needs_manual_code
 * после ретрая, который на самом деле удался — см. tg_agent_autoregistration_retry_code).
 */
export function promoteToWorkspace(agentId: string, accountConfig: AccountConfig): void {
    writeStagingStatus(agentId, "done");
    const staging = stagingDir(agentId);
    fs.writeFileSync(path.join(staging, "tg-account.json"), JSON.stringify(accountConfig, null, 2), "utf-8");
    fs.renameSync(staging, workspaceDir(agentId));
}
