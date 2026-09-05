// core/device-pool.ts — каталог реальных моделей устройств для fingerprint новых агентов.
//
// Модель и systemVersion подобраны по эпохе релиза конкретного устройства (не
// произвольно) — источник: общеизвестная история обновлений производителей. Тот же
// набор моделей использован при разовой миграции существующих 140 агентов
// (2026-08-25).
//
// appVersion — версии Telegram for Android, подтверждённые датированной историей
// релизов (t.me/tgstable, uptodown): 12.0.1(2025-09-01), 12.4.3(2026-02-16),
// 12.5.2(2026-03-18), 12.6.4(2026-04-09), 12.7.3(2026-05-15), 12.8.3(2026-06-20),
// 12.9.2(2026-08-01), 12.10.1(2026-08-25) — более старые исторические номера
// датированным источником подтвердить не удалось, поэтому не выдумывались. Каждой
// модели сопоставлены 3 из них (VERSION_BAND по эпохе) вместо одной — так одна и та
// же модель у разных агентов реалистично оказывается на соседних, а не всегда
// идентичных сборках Telegram (пользователи одного и того же телефона обновляют
// приложение не одновременно).
//
// DEVICE_POOL — модель × appVersion из её VERSION_BAND: 142 модели × 3 версии = 426
// уникальных комбинаций. Комбинация допускает переиспользование до MAX_AGENTS_PER_COMBO
// агентами (см. pickDevice) — 426 × 3 = 1278 достаточно для 1000 агентов с запасом.

import * as fs from "fs";
import { listAgentIds, accountConfigPath } from "./config";
import { listStagingAgentIds, stagingDir } from "./tg-agent-autoregistration/staging";
import * as path from "path";

export interface DeviceProfile {
    deviceModel: string;
    systemVersion: string;
    appVersion: string;
}

/** Сколько агентов максимум могут получить абсолютно одинаковую тройку (модель+ОС+appVersion). */
export const MAX_AGENTS_PER_COMBO = 3;

const V_NEWEST = ["12.10.1", "12.9.2", "12.8.3"];
const V_RECENT = ["12.9.2", "12.8.3", "12.7.3"];
const V_MID = ["12.7.3", "12.6.4", "12.5.2"];
const V_OLDER = ["12.5.2", "12.4.3", "12.0.1"];
const V_LEGACY = ["12.0.1", "12.4.3", "12.5.2"];

interface DeviceBase {
    deviceModel: string;
    systemVersion: string;
    appVersions: string[];
}

const DEVICE_BASE: DeviceBase[] = [
    { deviceModel: "Google Pixel 9 Pro", systemVersion: "Android 15", appVersions: V_NEWEST },
    { deviceModel: "Google Pixel 9", systemVersion: "Android 15", appVersions: V_NEWEST },
    { deviceModel: "Google Pixel 8a", systemVersion: "Android 15", appVersions: V_NEWEST },
    { deviceModel: "OnePlus 12R", systemVersion: "Android 15", appVersions: V_NEWEST },

    { deviceModel: "Samsung Galaxy S24 Ultra", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Samsung Galaxy S24+", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Samsung Galaxy S24", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Samsung Galaxy S23 Ultra", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Samsung Galaxy S23+", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Samsung Galaxy S23", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Samsung Galaxy S23 FE", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Samsung Galaxy Z Flip5", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Samsung Galaxy Z Fold5", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Samsung Galaxy A55", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Samsung Galaxy A54", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Google Pixel 8 Pro", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Google Pixel 8", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Google Pixel 7 Pro", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Google Pixel 7", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Google Pixel 7a", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "OnePlus 12", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "OnePlus 11", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "OnePlus Nord 3", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Xiaomi 14", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Xiaomi 14 Pro", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Xiaomi 13", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Xiaomi 13 Pro", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Xiaomi 13T", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Xiaomi 13 Lite", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Poco F6", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Realme GT5", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Vivo X100 Pro", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Oppo Find X7", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Honor Magic6 Pro", systemVersion: "Android 14", appVersions: V_RECENT },
    { deviceModel: "Nothing Phone (2)", systemVersion: "Android 14", appVersions: V_RECENT },

    { deviceModel: "Samsung Galaxy A34", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Samsung Galaxy A14", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Samsung Galaxy M34", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Samsung Galaxy A04s", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Redmi Note 12", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Redmi Note 12S", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Redmi 12", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Poco M6 Pro", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Realme 10", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Realme C55", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Realme Narzo 60", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Realme Narzo 50", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Vivo Y100", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Vivo Y36", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Oppo A78", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Oppo Reno8 T", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Honor X9b", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Motorola Moto G84", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Motorola Moto G73", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Nokia G42", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Nokia X30", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Infinix Zero 30", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Infinix Note 30", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "Tecno Camon 20", systemVersion: "Android 13", appVersions: V_MID },
    { deviceModel: "ZTE Blade V40", systemVersion: "Android 13", appVersions: V_MID },

    { deviceModel: "Samsung Galaxy A32", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Samsung Galaxy A22", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Samsung Galaxy M32", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Xiaomi Mi 11", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Xiaomi 11T", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Redmi Note 11", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Redmi Note 11S", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Redmi 10", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Poco X4 Pro", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Realme 9", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Realme 8i", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Vivo Y21", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Vivo Y33s", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Oppo A96", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Oppo A76", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Honor 50", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Motorola Moto G60", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Motorola Moto G31", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Nokia G21", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Infinix Hot 12", systemVersion: "Android 12", appVersions: V_OLDER },
    { deviceModel: "Tecno Spark 9", systemVersion: "Android 12", appVersions: V_OLDER },

    { deviceModel: "Samsung Galaxy A21s", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Samsung Galaxy A12", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Samsung Galaxy M21", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi Note 9", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi Note 9S", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi 9", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Poco M3", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Realme 7", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Realme C21", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Vivo Y20", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Oppo A54", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Oppo A15", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Honor 9A", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Motorola Moto G9 Play", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "Nokia 5.4", systemVersion: "Android 11", appVersions: V_LEGACY },
    { deviceModel: "LG K52", systemVersion: "Android 11", appVersions: V_LEGACY },

    { deviceModel: "Samsung Galaxy A10", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Samsung Galaxy A20", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Samsung Galaxy M10", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi 8", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi 8A", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Mi A3", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Realme 5", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Realme C2", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Vivo Y12", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Oppo A5 (2020)", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Honor 8A", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Motorola Moto G8 Power", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "Nokia 5.1 Plus", systemVersion: "Android 10", appVersions: V_LEGACY },
    { deviceModel: "LG K40", systemVersion: "Android 10", appVersions: V_LEGACY },

    { deviceModel: "Samsung Galaxy J6 (2018)", systemVersion: "Android 9", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi Note 5 Pro", systemVersion: "Android 9", appVersions: V_LEGACY },
    { deviceModel: "Nokia 3.1", systemVersion: "Android 9", appVersions: V_LEGACY },
    { deviceModel: "Huawei Y6 (2019)", systemVersion: "Android 9", appVersions: V_LEGACY },
    { deviceModel: "Huawei P Smart (2019)", systemVersion: "Android 9", appVersions: V_LEGACY },

    { deviceModel: "Samsung Galaxy J4 (2018)", systemVersion: "Android 8.1", appVersions: V_LEGACY },
    { deviceModel: "Samsung Galaxy J4+ (2018)", systemVersion: "Android 8.1", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi 6", systemVersion: "Android 8.1", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi 6A", systemVersion: "Android 8.1", appVersions: V_LEGACY },
    { deviceModel: "Huawei Y5 (2018)", systemVersion: "Android 8.1", appVersions: V_LEGACY },
    { deviceModel: "Huawei Y6 (2018)", systemVersion: "Android 8.0", appVersions: V_LEGACY },
    { deviceModel: "Huawei Y5 Prime (2018)", systemVersion: "Android 8.1", appVersions: V_LEGACY },
    { deviceModel: "Nokia 2", systemVersion: "Android 8.1", appVersions: V_LEGACY },
    { deviceModel: "Nokia 2.1", systemVersion: "Android 8.1", appVersions: V_LEGACY },
    { deviceModel: "Sony Xperia XA1", systemVersion: "Android 8.0", appVersions: V_LEGACY },
    { deviceModel: "Motorola Moto G5", systemVersion: "Android 8.1", appVersions: V_LEGACY },
    { deviceModel: "Motorola Moto G5S", systemVersion: "Android 8.1", appVersions: V_LEGACY },

    { deviceModel: "Samsung Galaxy J3 (2017)", systemVersion: "Android 7.0", appVersions: V_LEGACY },
    { deviceModel: "Samsung Galaxy J5 (2016)", systemVersion: "Android 7.0", appVersions: V_LEGACY },
    { deviceModel: "Samsung Galaxy J7 (2016)", systemVersion: "Android 7.0", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi 5A", systemVersion: "Android 7.1.2", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi 5", systemVersion: "Android 7.1.2", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi 5 Plus", systemVersion: "Android 7.1.2", appVersions: V_LEGACY },
    { deviceModel: "Huawei Y5 (2017)", systemVersion: "Android 7.0", appVersions: V_LEGACY },
    { deviceModel: "LG K10 (2017)", systemVersion: "Android 7.0", appVersions: V_LEGACY },

    { deviceModel: "Xiaomi Redmi 4C", systemVersion: "Android 6.0", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi 4A", systemVersion: "Android 6.0", appVersions: V_LEGACY },
    { deviceModel: "Xiaomi Redmi 4X", systemVersion: "Android 6.0.1", appVersions: V_LEGACY },
    { deviceModel: "Samsung Galaxy J2 (2016)", systemVersion: "Android 5.1", appVersions: V_LEGACY },
    { deviceModel: "Samsung Galaxy J3 (2016)", systemVersion: "Android 6.0.1", appVersions: V_LEGACY },
    { deviceModel: "Samsung Galaxy J5 Prime", systemVersion: "Android 6.0.1", appVersions: V_LEGACY },
];

/** 142 моделей × 3 appVersion = 426 уникальных комбинаций (модель+ОС+Telegram). */
export const DEVICE_POOL: DeviceProfile[] = DEVICE_BASE.flatMap((base) =>
    base.appVersions.map((appVersion) => ({
        deviceModel: base.deviceModel,
        systemVersion: base.systemVersion,
        appVersion,
    })),
);

function comboKey(d: DeviceProfile): string {
    return `${d.deviceModel} ${d.systemVersion} ${d.appVersion}`;
}

/**
 * Сколько раз каждая точная комбинация (модель+ОС+appVersion) уже занята —
 * существующими агентами (`tg-account.json`) и агентами той же незавершённой пачки
 * автогистрации, ещё не promoted в workspace (`device.json` в стейджинге).
 */
export function usedComboCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const bump = (d: Partial<DeviceProfile> | undefined) => {
        if (!d?.deviceModel || !d.systemVersion || !d.appVersion) return;
        const key = comboKey(d as DeviceProfile);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    };

    for (const agentId of listAgentIds()) {
        try {
            const raw = fs.readFileSync(accountConfigPath(agentId), "utf-8");
            bump(JSON.parse(raw)?.device);
        } catch {
            // нет файла / битый JSON — не считается занятой комбинацией.
        }
    }
    for (const agentId of listStagingAgentIds()) {
        try {
            const raw = fs.readFileSync(path.join(stagingDir(agentId), "device.json"), "utf-8");
            bump(JSON.parse(raw));
        } catch {
            // ещё не назначено устройство для этого агента стейджинга.
        }
    }
    return counts;
}

/**
 * Первая комбинация из пула, занятая менее `MAX_AGENTS_PER_COMBO` раз согласно `counts`
 * (см. `usedComboCounts`). Пул проходится по порядку — комбинации заполняются до
 * потолка последовательно, не вразнобой.
 */
export function pickDevice(counts: Map<string, number>): DeviceProfile {
    const device = DEVICE_POOL.find((d) => (counts.get(comboKey(d)) ?? 0) < MAX_AGENTS_PER_COMBO);
    if (!device) {
        throw new Error(
            `пул реальных устройств исчерпан (${DEVICE_POOL.length} комбинаций × ${MAX_AGENTS_PER_COMBO} = ` +
            `${DEVICE_POOL.length * MAX_AGENTS_PER_COMBO} мест все заняты) — добавьте новые модели в src/core/device-pool.ts`,
        );
    }
    return device;
}
