// core/tg-agent-autoregistration/proxy-selection.ts — подбор мобильного прокси (R-1, R-12).
//
// provision-proxy-for-new-agent.ts переиспользуется без изменений в контракте вызова —
// вызывается подпроцессом в режиме --create-candidate (mobile-proxy-unique-exit-ip: кандидаты
// берутся из существующего инвентаря asocks, не создаются и не удаляются — удалять на стороне
// asocks больше нечего, поэтому отдельного «удалить» больше нет). Цикл ретраев и решение
// "успех/неудача" ведёт этот модуль, не скрипт.
//
// `--create-candidate` — процесс на каждую попытку новый (stateless), поэтому логины,
// отвергнутые в более ранних попытках ЭТОГО ЖЕ прогона, этот модуль копит сам (`rejected`) и
// передаёт скрипту через `--exclude` — иначе один и тот же уже отвергнутый кандидат мог бы
// снова оказаться первым в списке `/proxy/search` на следующей попытке.

import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import type { Logger } from "../logger";
import type { ProxyConfig } from "../config";
import { TdataConnectError } from "../tdata";

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = path.join(__dirname, "..", "..", "scripts", "provision-proxy-for-new-agent.ts");

async function runTsx(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("npx", ["tsx", SCRIPT_PATH, ...args]);
    return stdout;
}

export async function createProxyCandidate(
    agentId: string,
    region: string,
    exclude: string[],
    log: Logger,
): Promise<ProxyConfig | null> {
    const args = ["--create-candidate", "--agent-id", agentId, "--country", region];
    if (exclude.length > 0) args.push("--exclude", exclude.join(","));
    const stdout = await runTsx(args);
    const parsed = JSON.parse(stdout.trim());
    if (parsed?.ok === false) {
        log.warn(`[proxy-selection] createProxyCandidate — пул мобильных прокси для "${region}" исчерпан`);
        return null;
    }
    const candidate = parsed as ProxyConfig;
    log.info(`[proxy-selection] createProxyCandidate — ${candidate.host}:${candidate.port}`);
    return candidate;
}

export type ProxySelectionOutcome<T> = { kind: "connected"; proxy: ProxyConfig; value: T } | { kind: "exhausted" };

/**
 * Подбор рабочего прокси (R-1, R-12): на каждую попытку — следующий ещё не отвергнутый кандидат
 * из инвентаря asocks. `tryConnect` бросает `TdataConnectError` на сетевую неудачу (кандидат
 * запоминается как отвергнутый, берётся следующий) — любая другая ошибка (в первую очередь
 * `TdataSetupError`) прекращает подбор немедленно, не исчерпывая `maxAttempts`: смена прокси не
 * помогает при ошибке подготовки аккаунта, причина не в сети (R-1).
 */
export async function selectWorkingProxy<T>(
    agentId: string,
    region: string,
    maxAttempts: number,
    tryConnect: (proxy: ProxyConfig) => Promise<T>,
    log: Logger,
): Promise<ProxySelectionOutcome<T>> {
    const rejected: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const candidate = await createProxyCandidate(agentId, region, rejected, log);
        if (!candidate) return { kind: "exhausted" };
        try {
            const value = await tryConnect(candidate);
            return { kind: "connected", proxy: candidate, value };
        } catch (err: any) {
            if (err instanceof TdataConnectError) {
                if (candidate.username) rejected.push(candidate.username);
                continue;
            }
            throw err;
        }
    }
    return { kind: "exhausted" };
}
