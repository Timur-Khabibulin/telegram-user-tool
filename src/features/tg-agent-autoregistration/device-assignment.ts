// features/tg-agent-autoregistration/device-assignment.ts — назначение реального,
// не пересекающегося с другими агентами устройства новому агенту (R-D1 расширение).
//
// Назначение персистится в стейджинге (`device.json`, рядом с `status.json`/`tdata/`)
// в момент первого вызова — так retryManualCode переиспользует то же устройство, а не
// подбирает новое при повторной попытке того же агента. Другие агенты, ещё не
// promoted (в стейджинге прошлых или текущей пачки), учитываются как занятые —
// иначе два агента одной пачки могли бы получить одну модель.

import * as fs from "fs";
import * as path from "path";
import { pickDevice, usedComboCounts } from "../../core/device-pool";
import type { DeviceConfig } from "../../core/config";
import { stagingDir } from "./staging";

function stagingDevicePath(agentId: string): string {
    return path.join(stagingDir(agentId), "device.json");
}

function readStagedDevice(agentId: string): DeviceConfig | null {
    try {
        return JSON.parse(fs.readFileSync(stagingDevicePath(agentId), "utf-8")) as DeviceConfig;
    } catch {
        return null;
    }
}

/**
 * Возвращает устройство для агента — из стейджинга, если уже назначено (ретрай), иначе
 * подбирает по `usedComboCounts`/`pickDevice` (учитывает и существующих агентов, и
 * другие ещё не promoted агенты той же пачки автогистрации — не выдаст комбинацию
 * сверх MAX_AGENTS_PER_COMBO) и сохраняет. Идемпотентна для одного и того же agentId.
 * langCode/systemLangCode фиксированы на "ru" — платформа работает только с
 * ru-аккаунтами (тот же выбор, что и у остальных агентов).
 */
export function assignDeviceForAgent(agentId: string): DeviceConfig {
    const existing = readStagedDevice(agentId);
    if (existing) return existing;

    const picked = pickDevice(usedComboCounts());
    const device: DeviceConfig = { ...picked, langCode: "ru", systemLangCode: "ru" };
    fs.mkdirSync(stagingDir(agentId), { recursive: true });
    const tmpPath = `${stagingDevicePath(agentId)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(device, null, 2), "utf-8");
    fs.renameSync(tmpPath, stagingDevicePath(agentId));
    return device;
}

/** Убирает `device.json` из стейджинга перед promoteToWorkspace — не переезжает в workspace. */
export function clearStagedDevice(agentId: string): void {
    fs.rmSync(stagingDevicePath(agentId), { force: true });
}
