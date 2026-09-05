// core/tg-agent-autoregistration/username.ts — генерация username аккаунта (R-4).
//
// nick из profile_data.json — общий префикс на всю персону; постфикс — случайный
// человекочитаемый (слово + двузначное число, не hex/hash-подобный), чтобы аккаунты
// одной персоны не коллидировали друг с другом по Telegram username.

import * as fs from "fs";
import * as path from "path";
import { stagingDir } from "./staging";

const SUFFIX_WORDS = [
    "sky", "wave", "moon", "star", "leaf", "frost", "storm", "river", "glow", "dawn",
    "spark", "cloud", "flame", "haze", "drift", "echo", "swift", "ember", "mist", "tide",
    "grove", "reef", "peak", "vale", "bloom", "willow", "cove", "fern", "quartz", "amber",
];

/** username = nick + "_" + случайное слово + случайное двузначное число. */
export function generateUsername(nickPrefix: string): string {
    const word = SUFFIX_WORDS[Math.floor(Math.random() * SUFFIX_WORDS.length)];
    const num = Math.floor(10 + Math.random() * 90);
    return `${nickPrefix}_${word}${num}`;
}

function stagingUsernamePath(agentId: string): string {
    return path.join(stagingDir(agentId), "username.txt");
}

/**
 * Username агента — из стейджинга, если уже сгенерирован (ретрай `retryManualCode`), иначе
 * генерирует новый и сохраняет. Идемпотентна для одного agentId — ретрай должен переиспользовать
 * тот же username, что уже применён к Telegram-аккаунту в первой попытке (`Api.account.
 * UpdateUsername` в `prepareAccount`, до таймаута кода), не генерировать другой поверх него.
 */
export function assignUsernameForAgent(agentId: string, nickPrefix: string): string {
    try {
        const existing = fs.readFileSync(stagingUsernamePath(agentId), "utf-8").trim();
        if (existing) return existing;
    } catch {
        // не сгенерирован ранее — сгенерировать и сохранить ниже
    }

    const username = generateUsername(nickPrefix);
    fs.mkdirSync(stagingDir(agentId), { recursive: true });
    const tmpPath = `${stagingUsernamePath(agentId)}.tmp`;
    fs.writeFileSync(tmpPath, username, "utf-8");
    fs.renameSync(tmpPath, stagingUsernamePath(agentId));
    return username;
}

/** Убирает `username.txt` из стейджинга перед promoteToWorkspace — не переезжает в workspace
 *  (значение уже встроено в `accountConfig.username`). */
export function clearStagedUsername(agentId: string): void {
    fs.rmSync(stagingUsernamePath(agentId), { force: true });
}
