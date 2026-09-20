// features/tg-agent-autoregistration/persona-template.ts — шаблон персоны (R-D1).
//
// Шаблон читается один раз на весь прогон (одна персона на пачку аккаунтов, R из
// requirements-v1.md §2.1). Отсутствие папки/обязательного файла — не повод падать
// глубоко в стеке: run.ts ловит PersonaTemplateError сам и сообщает оператору (R-10),
// не начиная скачивание.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { personasRoot } from "../../core/config";

export function autoregistrationRoot(): string {
    return path.join(os.homedir(), ".openclaw", "tg-agent-autoregistration");
}

/** Каталог шаблона персоны — общий ~/.openclaw/personas/<personName>/ (agent-persona-template). */
export function templatesDir(personName: string): string {
    return path.join(personasRoot(), personName);
}

export class PersonaTemplateError extends Error {}

export interface DefaultAgentData {
    apiId: number;
    apiHash: string;
    "2fa": string;
}

export interface Birthdate {
    day: number;
    month: number;
    year?: number;
}

export interface ProfileData {
    name: string;
    nick: string;
    birthdate: Birthdate;
    bio: string;
    channelName: string;
}

export interface PersonaTemplate {
    personName: string;
    /** Канальные поля (post/channel_photo/channel_post_photo) — null, если шаблон
     *  загружен без requireChannel (mode A, канал не создаётся). */
    postText: string | null;
    /** Все photo_profile_N по возрастанию номера (R-5 — грузятся все, не только первое). */
    photoProfilePaths: string[];
    channelPhotoPath: string | null;
    channelPostPhotoPath: string | null;
    defaultAgentData: DefaultAgentData;
    profileData: ProfileData;
    /** SOUL.md больше не обязателен (в реге не используется) — null, если файла нет. */
    soulMdPath: string | null;
}

function requireFile(dir: string, name: string): string {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
        throw new PersonaTemplateError(`шаблон персоны: не найден обязательный файл "${name}" (${p})`);
    }
    return p;
}

/**
 * Ищет файл по базовому имени с любым расширением (`channel_photo.jpg`,
 * `channel_photo.png`, ...) — расширение сохраняется в возвращённом пути и
 * дальше идёт в Telegram вместе с именем файла (CustomFile), в отличие от
 * точного совпадения без расширения. При нескольких файлах с одинаковым
 * базовым именем и разными расширениями берётся первый по алфавиту — не
 * ожидаемый сценарий для нормально собранного шаблона, но не падает.
 */
function requireFileWithAnyExtension(dir: string, baseName: string): string {
    const pattern = new RegExp(`^${baseName}\\.\\w+$`);
    const match = fs.readdirSync(dir).filter((f) => pattern.test(f)).sort()[0];
    if (!match) {
        throw new PersonaTemplateError(`шаблон персоны: не найден обязательный файл "${baseName}.*" (${dir})`);
    }
    return path.join(dir, match);
}

/** Как requireFile, но возвращает null вместо ошибки, если файла нет (опциональные файлы mode A). */
function optionalFile(dir: string, name: string): string | null {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? p : null;
}

/** Как requireFileWithAnyExtension, но null вместо ошибки, если файла нет. */
function optionalFileWithAnyExtension(dir: string, baseName: string): string | null {
    const pattern = new RegExp(`^${baseName}\\.\\w+$`);
    const match = fs.readdirSync(dir).filter((f) => pattern.test(f)).sort()[0];
    return match ? path.join(dir, match) : null;
}

/** photo_profile_1.jpg, photo_profile_2.png, ... — сортировка по номеру, не по алфавиту имени файла. */
function listProfilePhotos(dir: string): string[] {
    return fs
        .readdirSync(dir)
        .filter((f) => /^photo_profile_\d+\.\w+$/.test(f))
        .sort((a, b) => Number(a.match(/^photo_profile_(\d+)\./)![1]) - Number(b.match(/^photo_profile_(\d+)\./)![1]))
        .map((f) => path.join(dir, f));
}

/**
 * @param requireChannel — если true, канальные файлы (`post.txt`, `channel_photo.*`,
 *   `channel_post_photo.*`) и `channelName` обязательны (mode B / создание канала).
 *   Если false (mode A — рега без канала, createPublicChannel=false), они опциональны:
 *   канал не создаётся, эти файлы не нужны. `SOUL.md` не обязателен в обоих режимах
 *   (в реге не используется).
 */
export function loadPersonaTemplate(personName: string, requireChannel: boolean): PersonaTemplate {
    const dir = templatesDir(personName);
    if (!fs.existsSync(dir)) {
        throw new PersonaTemplateError(`шаблон персоны "${personName}" не найден: ${dir}`);
    }

    // Канальные файлы — обязательны только при создании канала (requireChannel).
    const postTextPath = requireChannel ? requireFile(dir, "post.txt") : optionalFile(dir, "post.txt");
    const channelPhotoPath = requireChannel
        ? requireFileWithAnyExtension(dir, "channel_photo")
        : optionalFileWithAnyExtension(dir, "channel_photo");
    const channelPostPhotoPath = requireChannel
        ? requireFileWithAnyExtension(dir, "channel_post_photo")
        : optionalFileWithAnyExtension(dir, "channel_post_photo");

    const defaultAgentDataPath = requireFile(dir, "default_agent_data.json");
    const profileDataPath = requireFile(dir, "profile_data.json");
    const soulMdPath = optionalFile(dir, "SOUL.md");

    const photoProfilePaths = listProfilePhotos(dir);
    if (photoProfilePaths.length === 0) {
        throw new PersonaTemplateError(`шаблон персоны "${personName}": нет ни одного photo_profile_N.*`);
    }

    const defaultAgentData = JSON.parse(fs.readFileSync(defaultAgentDataPath, "utf-8")) as DefaultAgentData;
    if (!defaultAgentData.apiId || !defaultAgentData.apiHash || !defaultAgentData["2fa"]) {
        throw new PersonaTemplateError(
            `шаблон персоны "${personName}": default_agent_data.json неполон (нужны apiId, apiHash, 2fa)`,
        );
    }

    // channelName нужен только для создания канала (requireChannel).
    const profileData = JSON.parse(fs.readFileSync(profileDataPath, "utf-8")) as ProfileData;
    if (!profileData.name || !profileData.nick || !profileData.birthdate || (requireChannel && !profileData.channelName)) {
        throw new PersonaTemplateError(
            `шаблон персоны "${personName}": profile_data.json неполон (нужны name, nick, birthdate${requireChannel ? ", channelName" : ""})`,
        );
    }

    return {
        personName,
        postText: postTextPath ? fs.readFileSync(postTextPath, "utf-8") : null,
        photoProfilePaths,
        channelPhotoPath,
        channelPostPhotoPath,
        defaultAgentData,
        profileData,
        soulMdPath,
    };
}
