// features/tg-agent-pool-provision/staging.ts — стейджинг продюсера пула
// (tg-agent-pool-provisioning, фаза 1). До готовности пул-аккаунт живёт здесь,
// не в workspace-emptyAccount<K>/ — иначе его подхватят потребители пула
// (banned-replacement / фаза 2) до полной сборки.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { workspaceDir, type PoolAccountConfig } from "../../core/config";

export function poolProvisionRoot(): string {
    return path.join(os.homedir(), ".openclaw", "tg-agent-pool-provisioning");
}

export function stagingRoot(): string {
    return path.join(poolProvisionRoot(), "staging");
}

export function stagingDir(poolId: string): string {
    return path.join(stagingRoot(), poolId);
}

export function stagingTdataDir(poolId: string): string {
    return path.join(stagingDir(poolId), "tdata");
}

/**
 * Путь в стейджинге для файла 2FA-пароля, скачанного из архива рядом с tdata.
 * Хранится по basename имени (без вложенных путей) как сосед `tdata/`.
 */
export function stagingPasswordFilePath(poolId: string, fileName: string): string {
    return path.join(stagingDir(poolId), path.basename(fileName));
}

export type PoolAccountStatus = "proxy_failed" | "setup_failed" | "needs_manual_code" | "done";

export interface PoolStagingStatus {
    status: PoolAccountStatus;
    error?: string;
    updatedAt: number;
}

function statusPath(poolId: string): string {
    return path.join(stagingDir(poolId), "status.json");
}

/** Атомарная запись status.json — tmp + renameSync. */
export function writeStagingStatus(poolId: string, status: PoolAccountStatus, error?: string): void {
    fs.mkdirSync(stagingDir(poolId), { recursive: true });
    const payload: PoolStagingStatus = { status, error, updatedAt: Date.now() };
    const tmpPath = `${statusPath(poolId)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmpPath, statusPath(poolId));
}

export function readStagingStatus(poolId: string): PoolStagingStatus | null {
    const p = statusPath(poolId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as PoolStagingStatus;
}

/**
 * Следующая метка K = (максимальная присутствующая) + 1. Сканирует СЫРЫЕ имена в
 * ~/.openclaw (`workspace-emptyAccount<K>` и карантинные `...emptyAccount<K>.invalid`)
 * и стейджинг (`emptyAccount<K>`), чтобы переиспользованная метка не столкнулась с
 * карантинным каталогом. Пустой пул → 1.
 */
export function computeNextPoolNumber(): number {
    let max = 0;
    const consider = (n: number) => { if (Number.isFinite(n) && n > max) max = n; };

    const openclawRoot = path.join(os.homedir(), ".openclaw");
    try {
        for (const e of fs.readdirSync(openclawRoot, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const m = e.name.match(/^workspace-emptyAccount(\d+)(?:\..*)?$/);
            if (m) consider(Number(m[1]));
        }
    } catch { /* каталога ещё нет */ }

    try {
        for (const e of fs.readdirSync(stagingRoot(), { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const m = e.name.match(/^emptyAccount(\d+)$/);
            if (m) consider(Number(m[1]));
        }
    } catch { /* стейджинга ещё нет */ }

    return max + 1;
}

/**
 * Атомарный перенос готового пул-аккаунта: собирается tg-account.json в стейджинге
 * (tdata/ уже там из скачивания), затем один renameSync стейджинг → workspace-emptyAccount<K>.
 */
export function promoteToPool(poolId: string, poolConfig: PoolAccountConfig): void {
    writeStagingStatus(poolId, "done");
    const staging = stagingDir(poolId);
    fs.writeFileSync(path.join(staging, "tg-account.json"), JSON.stringify(poolConfig, null, 2), "utf-8");
    fs.renameSync(staging, workspaceDir(poolId));
}
