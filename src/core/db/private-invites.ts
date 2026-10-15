// core/db/private-invites.ts — реестр персональных инвайт-ссылок в приватный канал
// (private-invite-links).
//
// Одна строка на агента (PRIMARY KEY по agent_id) — повторная генерация ссылки
// для того же агента заменяет предыдущую запись, не накапливает дубли.

import Database from "better-sqlite3";
import { privateInvitesDbPath } from "../config";

export interface PrivateInviteLinkRow {
    agentId: string;
    inviteLink: string;
    createdAt: number;
    postUpdated: number; // 0 | 1 (SQLite не имеет boolean) — подтверждено вставлена в закреплённый пост
}

const initializedDbs = new Set<string>();

function openDb(adminAgentId: string): Database.Database {
    const db = new Database(privateInvitesDbPath(adminAgentId));
    ensureSchema(db, adminAgentId);
    return db;
}

function ensureSchema(db: Database.Database, key: string): void {
    if (initializedDbs.has(key)) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS private_invite_links (
            agent_id     TEXT    PRIMARY KEY,
            invite_link  TEXT    NOT NULL,
            created_at   INTEGER NOT NULL,
            post_updated INTEGER NOT NULL DEFAULT 0
        );
    `);
    // Миграция существующих баз, созданных до появления post_updated (idempotent).
    const columns = db.prepare(`PRAGMA table_info(private_invite_links)`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "post_updated")) {
        db.exec(`ALTER TABLE private_invite_links ADD COLUMN post_updated INTEGER NOT NULL DEFAULT 0`);
    }
    initializedDbs.add(key);
}

/** Идемпотентно создаёт схему. Безопасно вызывать на каждом прогоне. */
export function ensurePrivateInvitesSchema(adminAgentId: string): void {
    const db = openDb(adminAgentId);
    db.close();
}

/**
 * Создать/заменить ссылку агента. Новая ссылка ещё не вставлена ни в какой пост —
 * post_updated сбрасывается в 0, даже если предыдущая ссылка была подтверждена (1).
 */
export function upsertPrivateInviteLink(adminAgentId: string, agentId: string, inviteLink: string, createdAt: number): void {
    const db = openDb(adminAgentId);
    try {
        db.prepare(`
            INSERT INTO private_invite_links (agent_id, invite_link, created_at, post_updated)
            VALUES (@agentId, @inviteLink, @createdAt, 0)
            ON CONFLICT(agent_id) DO UPDATE SET
                invite_link  = excluded.invite_link,
                created_at   = excluded.created_at,
                post_updated = 0
        `).run({ agentId, inviteLink, createdAt });
    } finally {
        db.close();
    }
}

/**
 * Переносит строку реестра с ключа `fromAgentId` на `toAgentId` БЕЗ вызовов Telegram
 * (persona-account-reserve §6.4): сохраняет `invite_link`/`created_at`/`post_updated`,
 * меняет только `agent_id`. Нужен активации аккаунта резерва — ссылка создана при
 * провиженинге под ключом reserveId, URL ведёт в общий приватный канал воронки и от
 * конкретного аккаунта не зависит; активация лишь перекеивает запись на финальный agentId.
 *
 * Если строки `fromAgentId` нет — no-op. Если строка `toAgentId` уже есть (триггер 1,
 * у заменяемого агента осталась прежняя запись) — она перезаписывается: сначала
 * удаляется, затем ключ переносится. Всё в одной транзакции.
 */
export function rekeyPrivateInviteLink(adminAgentId: string, fromAgentId: string, toAgentId: string): void {
    if (fromAgentId === toAgentId) return;
    const db = openDb(adminAgentId);
    try {
        db.transaction(() => {
            const src = db.prepare(
                `SELECT invite_link AS inviteLink, created_at AS createdAt, post_updated AS postUpdated
                 FROM private_invite_links WHERE agent_id = @fromAgentId`,
            ).get({ fromAgentId }) as { inviteLink: string; createdAt: number; postUpdated: number } | undefined;
            if (!src) return;
            // Перезаписать возможную прежнюю запись цели, затем сменить ключ источника.
            db.prepare(`DELETE FROM private_invite_links WHERE agent_id = @toAgentId`).run({ toAgentId });
            db.prepare(`UPDATE private_invite_links SET agent_id = @toAgentId WHERE agent_id = @fromAgentId`)
                .run({ fromAgentId, toAgentId });
        })();
    } finally {
        db.close();
    }
}

/** Ссылка агента из реестра или null, если её ещё нет (для переиспользования без пересоздания). */
export function getPrivateInviteLink(adminAgentId: string, agentId: string): string | null {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(
            `SELECT invite_link AS inviteLink FROM private_invite_links WHERE agent_id = @agentId`,
        ).get({ agentId }) as { inviteLink: string } | undefined;
        return row?.inviteLink ?? null;
    } finally {
        db.close();
    }
}

/** Подтверждает, что ссылка агента реально вставлена в его закреплённый пост. */
export function markPostUpdated(adminAgentId: string, agentId: string): void {
    const db = openDb(adminAgentId);
    try {
        db.prepare(`UPDATE private_invite_links SET post_updated = 1 WHERE agent_id = @agentId`).run({ agentId });
    } finally {
        db.close();
    }
}

/** Все строки реестра — для проверки/дебага. */
export function listPrivateInviteLinks(adminAgentId: string): PrivateInviteLinkRow[] {
    const db = openDb(adminAgentId);
    try {
        return db.prepare(`
            SELECT agent_id AS agentId, invite_link AS inviteLink, created_at AS createdAt, post_updated AS postUpdated
            FROM private_invite_links
            ORDER BY agent_id
        `).all() as PrivateInviteLinkRow[];
    } finally {
        db.close();
    }
}

/**
 * Агенты, у которых ссылка создана, но ещё не подтверждена вставленной в пост
 * (post_updated=0) — список для повтора шага 2 без создания новой ссылки
 * (tg_private_invite_links, retryPendingOnly).
 */
export function listPendingPostUpdates(adminAgentId: string): PrivateInviteLinkRow[] {
    const db = openDb(adminAgentId);
    try {
        return db.prepare(`
            SELECT agent_id AS agentId, invite_link AS inviteLink, created_at AS createdAt, post_updated AS postUpdated
            FROM private_invite_links
            WHERE post_updated = 0
            ORDER BY agent_id
        `).all() as PrivateInviteLinkRow[];
    } finally {
        db.close();
    }
}
