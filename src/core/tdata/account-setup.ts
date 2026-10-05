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
import { loadAccountDefaults } from "../config";
import { generateChannelUsername } from "../pool-accounts";
import { buildPostTextWithInviteLink } from "../persona-post";
import { TdataSetupError } from "./errors";

// ── Человеческий ритм настройки одного аккаунта (human-pacing, уровень A) ──
// Живой человек не меняет профиль/имя/дату, не создаёт публичный канал и не
// клеймит публичный username встык за секунды. Между шагами настройки и между
// самыми рестрикт-чувствительными под-вызовами (UpdateUsername, CreateChannel,
// UpdateUsername канала) вставляется случайная пауза с джиттером — залп действий
// на свежей сессии молодого аккаунта и есть паттерн бота, который ловит антиспам.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Случайная пауза 3–12 с между шагами настройки аккаунта. */
function humanStepDelay(): Promise<void> {
    return sleep((3 + Math.random() * 9) * 1000);
}

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
        // currentPassword="" (аккаунт без 2FA) — штатно: GramJS авторизуется
        // InputCheckPasswordEmpty и ставит newPassword. Если 2FA на аккаунте есть,
        // а пароль пуст/неверен — PASSWORD_HASH_INVALID (уйдёт в setup_failed).
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
        await humanStepDelay();
        // account.updateUsername — отдельный вызов, не параметр UpdateProfile.
        await client.invoke(new Api.account.UpdateUsername({ username }));
        await humanStepDelay();
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
        let firstPhoto = true;
        for (const photoPath of photoPaths) {
            if (!firstPhoto) await humanStepDelay();
            firstPhoto = false;
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
    funnelInviteLink?: string,
): Promise<void> {
    // Канальные поля опциональны в типе (mode A их не грузит); здесь они обязаны
    // быть — канал создаётся только когда шаблон загружен с requireChannel=true.
    const { channelPhotoPath, channelPostPhotoPath, postText } = template;
    const channelName = template.profileData.channelName;
    if (!channelPhotoPath || !channelPostPhotoPath || postText == null || !channelName) {
        throw new TdataSetupError(
            "TEMPLATE_INCOMPLETE",
            `у персоны "${template.personName}" нет канальных файлов (post.txt/channel_photo/channel_post_photo/channelName) — канал не создать`,
        );
    }
    try {
        const created = await client.invoke(
            new Api.channels.CreateChannel({
                broadcast: true,
                title: channelName,
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
        await humanStepDelay();
        await client.invoke(new Api.channels.UpdateUsername({ channel: inputChannel, username: channelUsername }));

        await humanStepDelay();
        const avatarFile = await client.uploadFile({
            file: new CustomFile(
                path.basename(channelPhotoPath),
                fs.statSync(channelPhotoPath).size,
                channelPhotoPath,
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
        // Если передана персональная инвайт-ссылка воронки — она подставляется в пост
        // сразу (фаза 2), иначе используется текст post.txt как есть (autoregistration/retrofit).
        const caption = funnelInviteLink ? buildPostTextWithInviteLink(postText, funnelInviteLink) : postText;
        await humanStepDelay();
        await client.sendFile(inputChannel, { file: channelPostPhotoPath, caption });

        // Закрепление канала в профиле (R-6) — требует уже существующий
        // broadcast-канал с username (иначе PUBLIC_BROADCAST_EXPECTED), поэтому
        // строго после двух вызовов выше.
        await humanStepDelay();
        await client.invoke(new Api.account.UpdatePersonalChannel({ channel: inputChannel }));

        log.info(`[tdata] createPersonaChannel — канал создан и закреплён: @${channelUsername}`);
    } catch (err: any) {
        wrapTelegramError("createPersonaChannel", err);
    }
}

// ── Шаблонный канал (template-channel-phase1) ────────────────────────────

const CHANNEL_USERNAME_MAX_ATTEMPTS = 5;
const PLACEHOLDER_CHANNEL_TITLE = "Канал";
const PLACEHOLDER_CHANNEL_POST = "…";

/**
 * Клеймит публичный username канала с ретраем на коллизию. username — самостоятельный
 * случайный человекочитаемый (`generateChannelUsername`, без привязки к аккаунту/персоне);
 * при `USERNAME_OCCUPIED`/`USERNAME_INVALID`/`USERNAME_PURCHASE_AVAILABLE` генерируется
 * новый и клейм повторяется. Возвращает занятый username.
 */
async function claimChannelUsername(client: TelegramClient, channel: Api.InputChannel, log: Logger): Promise<string> {
    for (let attempt = 1; attempt <= CHANNEL_USERNAME_MAX_ATTEMPTS; attempt++) {
        const username = generateChannelUsername();
        try {
            await client.invoke(new Api.channels.UpdateUsername({ channel, username }));
            log.info(`[tdata] claimChannelUsername — @${username} (попытка ${attempt})`);
            return username;
        } catch (err: any) {
            const code: string = typeof err?.errorMessage === "string" ? err.errorMessage : (err?.message ?? "");
            const retriable = /USERNAME_OCCUPIED|USERNAME_INVALID|USERNAME_PURCHASE_AVAILABLE/.test(code);
            if (retriable && attempt < CHANNEL_USERNAME_MAX_ATTEMPTS) {
                log.warn(`[tdata] claimChannelUsername — @${username} отклонён (${code}), повтор`);
                await humanStepDelay();
                continue;
            }
            throw err;
        }
    }
    throw new TdataSetupError(
        "USERNAME_CLAIM_FAILED",
        `не удалось подобрать свободный username канала за ${CHANNEL_USERNAME_MAX_ATTEMPTS} попыток`,
    );
}

/**
 * Фаза 1: на bootstrap-сессии создаёт обезличенный шаблонный публичный канал —
 * `CreateChannel` + самостоятельный случайный человекочитаемый username (ретрай на
 * коллизию) + placeholder-пост + привязка к профилю (personal channel). Персональные
 * данные НЕ применяются (их наносит фаза 2 правкой этого канала). Создание канала на
 * «обжитой» bootstrap-сессии обходит `USER_RESTRICTED`, который Telegram даёт на
 * `CreateChannel` со свежей (агентской) сессии.
 */
export async function createTemplateChannel(client: TelegramClient, log: Logger): Promise<void> {
    try {
        const created = await client.invoke(
            new Api.channels.CreateChannel({ broadcast: true, title: PLACEHOLDER_CHANNEL_TITLE, about: "" }),
        );
        const chat = (created as any).chats?.[0] as Api.Channel | undefined;
        if (!chat || chat.accessHash == null) {
            throw new Error("channels.CreateChannel не вернул созданный канал в chats[]");
        }
        const inputChannel = new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash });

        await humanStepDelay();
        const channelUsername = await claimChannelUsername(client, inputChannel, log);

        // placeholder-пост — заменяется персональным в фазе 2.
        await humanStepDelay();
        await client.sendMessage(inputChannel, { message: PLACEHOLDER_CHANNEL_POST });

        // Привязка к профилю (personal channel) — фаза 2 найдёт канал по personalChannelId.
        // Требует уже заданного публичного username (сделан выше), иначе PUBLIC_BROADCAST_EXPECTED.
        await humanStepDelay();
        await client.invoke(new Api.account.UpdatePersonalChannel({ channel: inputChannel }));

        log.info(`[tdata] createTemplateChannel — шаблонный канал создан и привязан к профилю: @${channelUsername}`);
    } catch (err: any) {
        wrapTelegramError("createTemplateChannel", err);
    }
}

/**
 * Собственный канал аккаунта (personal channel) из `users.GetFullUser(self)`:
 * `personalChannelId` + `access_hash` из массива `chats` (та же конвенция, что
 * `service.getOwnPersonalChannel`). `null` — personal channel не задан.
 */
async function resolveOwnPersonalChannel(
    client: TelegramClient,
): Promise<{ inputChannel: Api.InputChannel; inputPeer: Api.InputPeerChannel } | null> {
    const full = await client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() }));
    const channelId = (full.fullUser as any)?.personalChannelId;
    if (channelId == null) return null;
    const chat = (full.chats as any[]).find(
        (c) => c instanceof Api.Channel && c.id?.toString() === channelId.toString(),
    ) as Api.Channel | undefined;
    if (!chat || chat.accessHash == null) return null;
    return {
        inputChannel: new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash }),
        inputPeer: new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash }),
    };
}

/**
 * Удаляет из канала все сообщения, КРОМЕ неудаляемого служебного о создании канала
 * (`messageActionChannelCreate`): placeholder-пост фазы 1 и служебные о смене названия/
 * фото, порождённые правками фазы 2. Удаление поштучное с игнором `MESSAGE_DELETE_FORBIDDEN`,
 * чтобы единичное неудаляемое служебное не срывало остальное.
 */
async function clearTemplateChannelHistory(
    client: TelegramClient,
    inputChannel: Api.InputChannel,
    inputPeer: Api.InputPeerChannel,
    log: Logger,
): Promise<void> {
    const messages = await client.getMessages(inputPeer, { limit: 100 });
    let deleted = 0;
    for (const m of messages as any[]) {
        if (m instanceof Api.MessageService && m.action instanceof Api.MessageActionChannelCreate) continue;
        try {
            await client.invoke(new Api.channels.DeleteMessages({ channel: inputChannel, id: [m.id] }));
            deleted++;
        } catch (err: any) {
            const code: string = typeof err?.errorMessage === "string" ? err.errorMessage : (err?.message ?? "");
            if (/MESSAGE_DELETE_FORBIDDEN/.test(code)) continue;
            throw err;
        }
    }
    log.info(`[tdata] clearTemplateChannelHistory — удалено ${deleted} сообщений (служебное о создании канала оставлено)`);
}

/**
 * Фаза 2: приводит уже существующий шаблонный канал к персональным данным — название →
 * `channelName`, фото персоны; зачищает историю (placeholder-пост + служебные об
 * изменениях, кроме «канал создан») и публикует персональный пост с инвайт-ссылкой
 * последним сообщением. Публичный username канала и привязку к профилю НЕ трогает
 * (заданы в фазе 1).
 */
async function applyPersonaToExistingChannel(
    client: TelegramClient,
    channel: { inputChannel: Api.InputChannel; inputPeer: Api.InputPeerChannel },
    template: PersonaTemplate,
    log: Logger,
    funnelInviteLink?: string,
): Promise<void> {
    const { channelPhotoPath, channelPostPhotoPath, postText } = template;
    const channelName = template.profileData.channelName;
    if (!channelPhotoPath || !channelPostPhotoPath || postText == null || !channelName) {
        throw new TdataSetupError(
            "TEMPLATE_INCOMPLETE",
            `у персоны "${template.personName}" нет канальных файлов (post.txt/channel_photo/channel_post_photo/channelName) — персону к каналу не применить`,
        );
    }
    try {
        const { inputChannel, inputPeer } = channel;

        await client.invoke(new Api.channels.EditTitle({ channel: inputChannel, title: channelName }));

        await humanStepDelay();
        const avatarFile = await client.uploadFile({
            file: new CustomFile(path.basename(channelPhotoPath), fs.statSync(channelPhotoPath).size, channelPhotoPath),
            workers: 1,
        });
        await client.invoke(
            new Api.channels.EditPhoto({ channel: inputChannel, photo: new Api.InputChatUploadedPhoto({ file: avatarFile }) }),
        );

        // Зачистка до публикации персонального поста — чтобы он остался последним сообщением.
        await humanStepDelay();
        await clearTemplateChannelHistory(client, inputChannel, inputPeer, log);

        const caption = funnelInviteLink ? buildPostTextWithInviteLink(postText, funnelInviteLink) : postText;
        await humanStepDelay();
        await client.sendFile(inputChannel, { file: channelPostPhotoPath, caption });

        log.info("[tdata] applyPersonaToExistingChannel — данные канала приведены к персональным, история зачищена");
    } catch (err: any) {
        wrapTelegramError("applyPersonaToExistingChannel", err);
    }
}

/**
 * Нанести персону на канал аккаунта (template-channel-phase1): если у аккаунта есть
 * собственный канал (personal channel, создан шаблонным в фазе 1) — привести его к
 * персональным данным; иначе (аккаунт без шаблонного канала) — создать канал прежним
 * способом. Покрывает фазу 2, авто-замену банов и пул-аккаунты, созданные до изменения.
 */
export async function applyOrCreatePersonaChannel(
    client: TelegramClient,
    template: PersonaTemplate,
    accountUsername: string,
    log: Logger,
    funnelInviteLink?: string,
): Promise<void> {
    const existing = await resolveOwnPersonalChannel(client);
    if (existing) {
        await applyPersonaToExistingChannel(client, existing, template, log, funnelInviteLink);
    } else {
        log.info("[tdata] applyOrCreatePersonaChannel — personal channel не найден, создаю канал прежним способом");
        await createPersonaChannel(client, template, accountUsername, log, funnelInviteLink);
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
    createPublicChannel: boolean,
): Promise<PrepareAccountResult> {
    await deleteExistingPhotos(client, log);
    await deleteAdminedPublicChannels(client, log);
    await change2FA(client, currentPassword, loadAccountDefaults()["2fa"], log);
    await resetOtherSessions(client, log);
    await applyProfile(client, username, template.profileData, log);
    await uploadProfilePhotos(client, template.photoProfilePaths, log);
    // Создание публичного канала — условно (mode A: без канала, mode B: как раньше).
    // Отдельно канал можно создать позже тулом tg_agent_channel_setup.
    if (createPublicChannel) {
        await createPersonaChannel(client, template, username, log);
    } else {
        log.info("[tdata] prepareAccount — createPublicChannel=false, шаг канала персоны пропущен");
    }

    const me = await client.getMe();
    return { telegramUserId: me.id.toString() };
}

/**
 * Гигиена купленного аккаунта для пула (tg-agent-pool-provision, фаза 1): удалить
 * унаследованные публичные каналы → сменить 2FA на общий целевой → сбросить чужие
 * сессии. Персона НЕ применяется (профиль/фото/username/канал — фаза 2). Фото
 * профиля здесь не удаляются (это делает применение персоны в фазе 2 перед
 * загрузкой новых). Тело — `prepareAccount` минус профиль/фото/канал.
 */
export async function prepareEmptyPoolAccount(
    client: TelegramClient,
    currentPassword: string,
    twoFaTarget: string,
    log: Logger,
): Promise<PrepareAccountResult> {
    await deleteAdminedPublicChannels(client, log);
    await humanStepDelay();
    await change2FA(client, currentPassword, twoFaTarget, log);
    await humanStepDelay();
    await resetOtherSessions(client, log);
    // Шаблонный публичный канал — на bootstrap-сессии (обходит USER_RESTRICTED на
    // CreateChannel со свежей сессии); персона наносится правкой в фазе 2.
    await humanStepDelay();
    await createTemplateChannel(client, log);

    const me = await client.getMe();
    return { telegramUserId: me.id.toString() };
}

/**
 * Настройка аккаунта под персону при авто-замене забаненного
 * (banned-account-replacement, R8/M3). Пул-аккаунты покупные — нужна полная
 * настройка под персону, но БЕЗ смены 2FA (`change2FA`) и БЕЗ сброса чужих сессий
 * (`resetOtherSessions`): то и другое сделано при первичном создании сессии пула.
 * Bootstrap-часть (расшифровка tdata, логин, приём кода) не нужна — сессия уже
 * готова, работаем сессией самого агента.
 *
 * Тело — профиль/фото + нанесение персоны на канал. Канал НЕ создаётся заново и
 * унаследованные публичные каналы НЕ удаляются (template-channel-phase1): шаблонный
 * канал создан в фазе 1 и является personal channel — `applyOrCreatePersonaChannel`
 * приводит его к персональным данным (а для аккаунта без шаблонного канала создаёт
 * прежним способом). Повторная активация после сбоя идемпотентна: правка уже
 * персонализированного канала безопасна.
 */
export async function setupReplacementAccount(
    client: TelegramClient,
    template: PersonaTemplate,
    username: string,
    log: Logger,
    funnelInviteLink?: string,
): Promise<PrepareAccountResult> {
    await deleteExistingPhotos(client, log);
    await humanStepDelay();
    await applyProfile(client, username, template.profileData, log);
    await humanStepDelay();
    await uploadProfilePhotos(client, template.photoProfilePaths, log);
    await humanStepDelay();
    // Канал НЕ создаётся заново и унаследованные публичные каналы НЕ удаляются:
    // шаблонный канал создан в фазе 1 и является personal channel — приводим его к
    // персональным данным. Для аккаунта без шаблонного канала — создаём прежним способом.
    await applyOrCreatePersonaChannel(client, template, username, log, funnelInviteLink);

    const me = await client.getMe();
    return { telegramUserId: me.id.toString() };
}
