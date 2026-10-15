// features/tg-agent-reserve-provision/staging.ts — стейджинг третьего пути
// подготовки (provision-в-резерв, persona-account-reserve §4.3). До готовности
// аккаунт живёт здесь, не в workspace-reserve-<persona>-<K>/ — иначе его увидят
// потребители резерва (замена банов / ручная активация) до полной сборки.
//
// Зеркало features/tg-agent-pool-provision/staging.ts; отличия: промоушен в резерв
// (workspace-reserve-<persona>-<K>) и пер-персонная нумерация (делегирует в
// core/reserve-accounts.computeNextReserveNumber со своим стейджинг-корнем).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { workspaceDir, type AccountConfig } from "../../core/config";
import { computeNextReserveNumber as coreComputeNextReserveNumber } from "../../core/reserve-accounts";

export function reserveProvisionRoot(): string {
    return path.join(os.homedir(), ".openclaw", "tg-agent-reserve-provisioning");
}

export function stagingRoot(): string {
    return path.join(reserveProvisionRoot(), "staging");
}

export function stagingDir(reserveId: string): string {
    return path.join(stagingRoot(), reserveId);
}

export function stagingTdataDir(reserveId: string): string {
    return path.join(stagingDir(reserveId), "tdata");
}

// Терминальные статусы — те же, что у фаз 1/2 (R9/AC-10).
export type ReserveAccountStatus = "proxy_failed" | "setup_failed" | "needs_manual_code" | "done";

export interface ReserveStagingStatus {
    status: ReserveAccountStatus;
    error?: string;
    updatedAt: number;
}

function statusPath(reserveId: string): string {
    return path.join(stagingDir(reserveId), "status.json");
}

/** Атомарная запись status.json — tmp + renameSync. */
export function writeStagingStatus(reserveId: string, status: ReserveAccountStatus, error?: string): void {
    fs.mkdirSync(stagingDir(reserveId), { recursive: true });
    const payload: ReserveStagingStatus = { status, error, updatedAt: Date.now() };
    const tmpPath = `${statusPath(reserveId)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmpPath, statusPath(reserveId));
}

export function readStagingStatus(reserveId: string): ReserveStagingStatus | null {
    const p = statusPath(reserveId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ReserveStagingStatus;
}

/**
 * Обвязка нумерации резерва: `computeNextReserveNumber` ядра плюс скан собственного
 * стейджинг-корня (`reserve-<persona>-<K>`), чтобы метка не столкнулась с ещё не
 * промоутнутым (неуспешным) каталогом прошлого прогона. Ядро путь стейджинга фичи
 * не знает — передаём его сюда.
 */
export function computeNextReserveNumber(persona: string): number {
    return coreComputeNextReserveNumber(persona, [stagingRoot()]);
}

/**
 * Атомарный перенос готового аккаунта в резерв: собирается tg-account.json в стейджинге
 * (tdata/ уже там из скачивания), затем один renameSync стейджинг → workspace-reserve-<persona>-<K>.
 * Атомарен в пределах одной ФС (всё под ~/.openclaw) — после `done` аккаунт целиком в
 * резерве либо целиком в стейджинге при сбое (AC-1).
 */
export function promoteToReserve(reserveId: string, accountConfig: AccountConfig): void {
    writeStagingStatus(reserveId, "done");
    const staging = stagingDir(reserveId);
    fs.writeFileSync(path.join(staging, "tg-account.json"), JSON.stringify(accountConfig, null, 2), "utf-8");
    fs.renameSync(staging, workspaceDir(reserveId));
}
