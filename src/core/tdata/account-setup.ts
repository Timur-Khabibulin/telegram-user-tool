// core/tdata/account-setup.ts — подготовка аккаунта на bootstrap-сессии
// (R-2, R-4, R-5, R-6, R-13; docs/design/tg-agent-autoregistration/architecture.md §2.3/2.4).
//
// Порядок вызовов внутри prepareAccount фиксирован и не переставляется без причины:
//   1) очистка унаследованных фото/публичных каналов (R-13) — до создания нового
//      контента, чтобы не упереться в CHANNELS_ADMIN_PUBLIC_TOO_MUCH при создании
//      канала персоны (architecture.md §2.4);
//   2) смена 2FA + сброс прочих сессий;
//   3) профиль/фото/канал — канал создаётся, получает username, и только потом
//      закрепляется в профиле (account.updatePersonalChannel требует уже готовый
//      broadcast-канал с username, иначе PUBLIC_BROADCAST_EXPECTED).
// Все MTProto-вызовы подтверждены чтением node_modules/telegram/tl/api.d.ts и
// core.telegram.org — не по памяти.

import * as fs from "fs";
import * as path from "path";
import bigInt from "big-integer";
import { TelegramClient, Api, utils } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import type { Logger } from "../logger";
import type { PersonaTemplate } from "../../features/tg-agent-autoregistration/persona-template";
import { TdataSetupError } from "./errors";

/** Оборачивает Telegram RPC-ошибку в TdataSetupError с сохранением исходного кода (4.7). */
function wrapTelegramError(step: string, err: any): never {
    if (err instanceof TdataSetupError) throw err;
    const code: string = typeof err?.errorMessage === "string" ? err.errorMessage : (err?.message ?? "UNKNOWN");
    throw new TdataSetupError(code, `${step}: ${err.message ?? err}`, err);
}

// ── Очистка предыдущего состояния (R-13, безусловная, необратимая) ────────

async function deleteExistingPhotos(client: TelegramClient, log: Logger): Promise<void> {
    try {
        const result = await client.invoke(
            new Api.photos.GetUserPhotos({
                userId: new Api.InputUserSelf(),
                offset: 0,
                maxId: bigInt.zero,
                limit: 100,
            }),
        );
        const list = (result as any).photos as Api.TypePhoto[];
        if (list.length === 0) return;
        const inputPhotos = list.map((p) => utils.getInputPhoto(p));
        await client.invoke(new Api.photos.DeletePhotos({ id: inputPhotos }));
        log.info(`[tdata] deleteExistingPhotos — удалено ${list.length} фото профиля`);
    } catch (err: any) {
        wrapTelegramError("deleteExistingPhotos", err);
    }
}

async function deleteAdminedPublicChannels(client: TelegramClient, log: Logger): Promise<void> {
    try {
        const result = await client.invoke(new Api.channels.GetAdminedPublicChannels({}));
        const chats = (result as any).chats as Api.TypeChat[];
        for (const chat of chats) {
            if (!(chat instanceof Api.Channel) || chat.accessHash == null) continue;
            const inputChannel = new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash });
            // CHANNEL_TOO_LARGE (>1000 участников) — обычная ошибка подготовки,
            // не отдельный случай (design.md §2.4) — пробрасывается общей обёрткой ниже.
            await client.invoke(new Api.channels.DeleteChannel({ channel: inputChannel }));
            log.info(`[tdata] deleteAdminedPublicChannels — удалён канал ${chat.id.toString()} (@${(chat as any).username ?? "?"})`);
        }
    } catch (err: any) {
        wrapTelegramError("deleteAdminedPublicChannels", err);
    }
}

// ── 2FA и сессии ────────────────────────────────────────────────────────

async function change2FA(client: TelegramClient, currentPassword: string, newPassword: string, log: Logger): Promise<void> {
    try {
        // client.updateTwoFaSettings — готовый метод GramJS, весь SRP-механизм
        // (computeCheck/computeDigest) уже внутри пакета (architecture.md §2.3).
        await client.updateTwoFaSettings({ currentPassword, newPassword, hint: "" });
        log.info("[tdata] change2FA — пароль сменён");
    } catch (err: any) {
        wrapTelegramError("change2FA", err);
    }
}

async function resetOtherSessions(client: TelegramClient, log: Logger): Promise<void> {
    try {
        // Не работает первые 24 часа после логина текущей сессии (ошибка 406) —
        // реальное ограничение API, не миф (architecture.md §2.3). Пробрасывается
        // как обычная TdataSetupError — возраст закупленных аккаунтов неизвестен заранее.
        await client.invoke(new Api.auth.ResetAuthorizations());
        log.info("[tdata] resetOtherSessions — прочие сессии сброшены");
    } catch (err: any) {
        wrapTelegramError("resetOtherSessions", err);
    }
}

// ── Профиль и фото ──────────────────────────────────────────────────────

async function applyProfile(
    client: TelegramClient,
    username: string,
    profile: PersonaTemplate["profileData"],
    log: Logger,
): Promise<void> {
    try {
        const [firstName, ...rest] = profile.name.trim().split(/\s+/);
        // account.updateProfile — поле за flags-битом: если не передать lastName
        // вовсе (undefined), Telegram НЕ очищает существующее значение, а
        // оставляет как есть. У купленных tdata-аккаунтов там часто мусорная
        // фамилия от прежнего фарма — явно шлём "" при отсутствии фамилии в
        // шаблоне персоны, чтобы гарантированно её стереть, а не унаследовать.
        const lastName = rest.length > 0 ? rest.join(" ") : "";
        await client.invoke(new Api.account.UpdateProfile({ firstName, lastName, about: profile.bio }));
        // account.updateUsername — отдельный вызов, не параметр UpdateProfile.
        await client.invoke(new Api.account.UpdateUsername({ username }));
        await client.invoke(
            new Api.account.UpdateBirthday({
                birthday: new Api.Birthday({
                    day: profile.birthdate.day,
                    month: profile.birthdate.month,
                    year: profile.birthdate.year,
                }),
            }),
        );
        log.info(`[tdata] applyProfile — профиль обновлён, username=@${username}`);
    } catch (err: any) {
        wrapTelegramError("applyProfile", err);
    }
}

async function uploadProfilePhotos(client: TelegramClient, photoPaths: string[], log: Logger): Promise<void> {
    try {
        for (const photoPath of photoPaths) {
            const file = await client.uploadFile({
                file: new CustomFile(path.basename(photoPath), fs.statSync(photoPath).size, photoPath),
                workers: 1,
            });
            await client.invoke(new Api.photos.UploadProfilePhoto({ file }));
        }
        log.info(`[tdata] uploadProfilePhotos — загружено ${photoPaths.length} фото (R-5, все photo_profile_N)`);
    } catch (err: any) {
        wrapTelegramError("uploadProfilePhotos", err);
    }
}

// ── Канал персоны ───────────────────────────────────────────────────────

/**
 * Экспортирована отдельно от `prepareAccount` (retrofit-persona-channel,
 * разовый скрипт): для уже работающих агентов, у которых канал персоны не
 * был создан при регистрации, нужно только это — без остального конвейера
 * (очистка фото/каналов, смена 2FA, сброс сессий, профиль/username), который
 * ломает уже настроенный аккаунт.
 */
export async function createPersonaChannel(
    client: TelegramClient,
    template: PersonaTemplate,
    accountUsername: string,
    log: Logger,
): Promise<void> {
    try {
        const created = await client.invoke(
            new Api.channels.CreateChannel({
                broadcast: true,
                title: template.profileData.channelName,
                about: "",
            }),
        );
        const chat = (created as any).chats?.[0] as Api.Channel | undefined;
        if (!chat || chat.accessHash == null) {
            throw new Error("channels.CreateChannel не вернул созданный канал в chats[]");
        }
        const inputChannel = new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash });

        // Публичный username канала — свой, отдельный от username аккаунта
        // (не параметр создания — отдельный вызов). Переиспользуем сгенерированный
        // для аккаунта username с суффиксом, а не отдельный генератор (R-4 покрывает
        // человекочитаемость и уникальность один раз).
        const channelUsername = `${accountUsername}_ch`;
        await client.invoke(new Api.channels.UpdateUsername({ channel: inputChannel, username: channelUsername }));

        const avatarFile = await client.uploadFile({
            file: new CustomFile(
                path.basename(template.channelPhotoPath),
                fs.statSync(template.channelPhotoPath).size,
                template.channelPhotoPath,
            ),
            workers: 1,
        });
        await client.invoke(
            new Api.channels.EditPhoto({
                channel: inputChannel,
                photo: new Api.InputChatUploadedPhoto({ file: avatarFile }),
            }),
        );

        // Пост — фото + текст (client.sendFile сам оборачивает InputMediaUploadedPhoto
        // и randomId, как уже используется для документов в core/telegram/service.ts).
        await client.sendFile(inputChannel, { file: template.channelPostPhotoPath, caption: template.postText });

        // Закрепление канала в профиле (R-6) — требует уже существующий
        // broadcast-канал с username (иначе PUBLIC_BROADCAST_EXPECTED), поэтому
        // строго после двух вызовов выше.
        await client.invoke(new Api.account.UpdatePersonalChannel({ channel: inputChannel }));

        log.info(`[tdata] createPersonaChannel — канал создан и закреплён: @${channelUsername}`);
    } catch (err: any) {
        wrapTelegramError("createPersonaChannel", err);
    }
}

// ── Оркестрация одного аккаунта ─────────────────────────────────────────

export interface PrepareAccountResult {
    telegramUserId: string;
}

/**
 * Полная подготовка аккаунта на bootstrap-сессии: очистка → 2FA/сессии →
 * профиль/фото/канал. Любая ошибка Telegram API на любом шаге всплывает как
 * TdataSetupError — вызывающий (run.ts) классифицирует это в status=setup_failed
 * и не пытается сменить прокси (R-1).
 */
export async function prepareAccount(
    client: TelegramClient,
    template: PersonaTemplate,
    currentPassword: string,
    username: string,
    log: Logger,
): Promise<PrepareAccountResult> {
    await deleteExistingPhotos(client, log);
    await deleteAdminedPublicChannels(client, log);
    await change2FA(client, currentPassword, template.defaultAgentData["2fa"], log);
    await resetOtherSessions(client, log);
    await applyProfile(client, username, template.profileData, log);
    await uploadProfilePhotos(client, template.photoProfilePaths, log);
    await createPersonaChannel(client, template, username, log);

    const me = await client.getMe();
    return { telegramUserId: me.id.toString() };
}
