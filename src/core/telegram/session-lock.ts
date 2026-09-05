// core/telegram/session-lock.ts — межпроцессный замок на MTProto-сессию агента.
//
// Одна сессия (sessionString = auth key) не переживает двух одновременных
// подключений: Telegram отвечает `406 AUTH_KEY_DUPLICATED` и рвёт соединение.
// На практике это происходит, когда оператор запускает второй прогон скрипта
// по тем же агентам, не заметив, что первый ещё жив (лог уже написал "done",
// но процесс не завершился), либо когда ручной скрипт пересекается с
// диспетчером по одному и тому же агенту.
//
// Механика: файл-замок ~/.openclaw/session-locks/<agentId>.lock создаётся
// атомарно через O_EXCL (fs.openSync(path, "wx")) — гонки между процессами
// невозможны, файл создаёт ровно один. Внутри JSON с PID владельца.
//   • Замок занят живым процессом → SessionBusyError (никакого второго коннекта).
//   • Владелец мёртв (упал, не сняв замок) → протухший замок перехватывается.
//   • Повторный захват того же агента ЭТИМ же процессом → no-op (реентрантно),
//     чтобы один процесс мог грузить аккаунт несколько раз подряд.
// Снятие: releaseSession() и автоматически на выходе процесса (exit/SIGINT/
// SIGTERM/SIGHUP) — иначе упавший прогон заблокировал бы агента навсегда.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ClientNotConnectedError } from "./errors";

const LOCK_DIR = path.join(os.homedir(), ".openclaw", "session-locks");

export interface LockHolder {
    /** PID процесса-владельца — по нему проверяется, жив ли замок. */
    pid: number;
    /** Кто держит: имя скрипта/скилла, для читаемой диагностики в логе. */
    owner: string;
    /** ISO-время захвата. */
    startedAt: string;
}

/**
 * Сессия агента уже занята другим живым процессом — подключаться нельзя.
 * Подкласс ClientNotConnectedError: для вызывающего это такой же «подключения
 * нет, прогон пора остановить», как таймаут коннекта, и существующий control-flow
 * (dispatcher.ts, discovery/similar.ts) обрабатывает её без доработок.
 */
export class SessionBusyError extends ClientNotConnectedError {
    readonly agentId: string;
    readonly holder: LockHolder;

    constructor(agentId: string, holder: LockHolder) {
        super(
            `сессия ${agentId} занята процессом PID ${holder.pid} (${holder.owner}, с ${holder.startedAt}) — ` +
            "второй одновременный коннект дал бы AUTH_KEY_DUPLICATED",
        );
        this.name = "SessionBusyError";
        this.agentId = agentId;
        this.holder = holder;
    }
}

/** Замки, взятые ЭТИМ процессом: реентрантность + снятие на выходе. */
const held = new Set<string>();
let exitHooked = false;

const lockPath = (agentId: string): string => path.join(LOCK_DIR, `${agentId}.lock`);

/** Жив ли процесс: сигнал 0 ничего не шлёт, только проверяет существование. */
function isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        // EPERM — процесс есть, но принадлежит другому пользователю: считаем живым.
        return err?.code === "EPERM";
    }
}

function readHolder(file: string): LockHolder | null {
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        return typeof raw?.pid === "number" ? (raw as LockHolder) : null;
    } catch {
        return null; // файла нет / битый JSON — владельца считаем неизвестным
    }
}

function hookExit(): void {
    if (exitHooked) return;
    exitHooked = true;
    const cleanup = (): void => {
        for (const agentId of [...held]) releaseSession(agentId);
    };
    // Обычное завершение (в т.ч. после необработанного исключения) — "exit"
    // срабатывает само; сигналы по умолчанию убивают процесс без "exit",
    // поэтому их снимаем явно.
    process.on("exit", cleanup);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(sig, () => {
            cleanup();
            process.exit(1);
        });
    }
}

/**
 * Захватывает сессию агента под этот процесс.
 * @throws SessionBusyError если сессию уже держит другой живой процесс.
 */
export function acquireSession(agentId: string, owner: string): void {
    if (held.has(agentId)) return; // уже держим — реентрантный вызов
    hookExit();
    fs.mkdirSync(LOCK_DIR, { recursive: true });

    const file = lockPath(agentId);
    const holder: LockHolder = { pid: process.pid, owner, startedAt: new Date().toISOString() };

    // Две попытки: вторая — после перехвата протухшего замка.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = fs.openSync(file, "wx"); // атомарно: создать или EEXIST
            try {
                fs.writeFileSync(fd, JSON.stringify(holder));
            } finally {
                fs.closeSync(fd);
            }
            held.add(agentId);
            return;
        } catch (err: any) {
            if (err?.code !== "EEXIST") throw err;

            const current = readHolder(file);
            if (current && current.pid !== process.pid && isAlive(current.pid)) {
                throw new SessionBusyError(agentId, current);
            }
            // Владелец мёртв или файл битый — снимаем протухший замок и пробуем снова.
            try {
                fs.unlinkSync(file);
            } catch {
                /* кто-то уже снял — не мешаем */
            }
        }
    }

    throw new SessionBusyError(
        agentId,
        readHolder(file) ?? { pid: -1, owner: "неизвестно", startedAt: "" },
    );
}

/** Снимает замок, если он взят этим процессом. Идемпотентно. */
export function releaseSession(agentId: string): void {
    if (!held.delete(agentId)) return;
    const file = lockPath(agentId);
    const current = readHolder(file);
    if (current && current.pid !== process.pid) return; // замок уже перехвачен — не трогаем чужой
    try {
        fs.unlinkSync(file);
    } catch {
        /* уже снят */
    }
}

/** Кто сейчас держит сессию агента (null — свободна). Для диагностики. */
export function inspectSession(agentId: string): LockHolder | null {
    const current = readHolder(lockPath(agentId));
    if (!current) return null;
    return isAlive(current.pid) ? current : null;
}
