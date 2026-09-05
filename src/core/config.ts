// core/config.ts — конфигурация аккаунта и пути к данным агента.
//
// Загрузка `tg-account.json` и все пути к БД собраны здесь, чтобы один и тот же
// источник истины использовали и плагин OpenClaw, и диспетчер. Пути не меняются
// относительно прежней реализации — данные переносятся бесшовно (R-D2).

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface ProxyConfig {
    type: "socks5" | "socks4";
    host: string;
    port: number;
    username?: string;
    password?: string;
    /** Имя прокси-порта на стороне провайдера (asocks) — для удаления по имени при
     *  повторном прогоне mobile-proxy-provisioning, если этот прокси снова сломается. */
    name?: string;
    /** Локация прокси на стороне провайдера (asocks) — сохраняется при первом успешном
     *  подборе, чтобы повторный прогон mobile-proxy-provisioning не запрашивал регион
     *  у юзера заново (tg-agent-create-proxy-provisioning). */
    countryCode?: string;
    state?: string;
    city?: string;
}

export interface DeviceConfig {
    deviceModel?: string;
    systemVersion?: string;
    appVersion?: string;
    langCode?: string;
    systemLangCode?: string;
}

export interface AccountConfig {
    accountId: string;
    apiId: number;
    apiHash: string;
    sessionString: string;
    /** Имя папки шаблона персоны в ~/.openclaw/personas/<persona>/ (agent-persona-template). */
    persona: string;
    /** Telegram @username аккаунта — ставится при регистрации (tg-agent-autoregistration,
     *  generateUsername) либо заполняется бэкфиллом чтением реального значения через getMe().
     *  Справочное поле, ни на что в рантайме не влияет. */
    username?: string;
    device?: DeviceConfig;
    proxy?: ProxyConfig;
    /** Ручной review-gate перед отправкой комментария monitor-v3 (post-comment-review, design.md решение 8). По умолчанию выключен. */
    reviewGateEnabled?: boolean;
}

// ─── Пути к данным агента ─────────────────────────────────────────────

/** Рабочая папка агента: ~/.openclaw/workspace-<agentId>. */
export function workspaceDir(agentId: string): string {
    return path.join(os.homedir(), ".openclaw", `workspace-${agentId}`);
}

/**
 * Идентификаторы всех агентов — по каталогам ~/.openclaw/workspace-<agentId>.
 * workspace-каталоги — фактический источник истины об агентах (отдельный реестр
 * пришлось бы синхронизировать). Используется дневной сводкой (обход всех агентов).
 */
export function listAgentIds(): string[] {
    const base = path.join(os.homedir(), ".openclaw");
    const prefix = "workspace-";
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((e) => e.isDirectory() && e.name.startsWith(prefix) && e.name.length > prefix.length)
        .map((e) => e.name.slice(prefix.length))
        .filter((agentId) => agentId !== REPORT_AGENT_ID);
}

export function accountConfigPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "tg-account.json");
}

/**
 * Логины (`proxy.username`) уже занятые каким-либо агентом — источник истины для проверки
 * уникальности прокси между агентами (mobile-proxy-unique-exit-ip), без отдельной БД: сканирует
 * `tg-account.json` всех агентов напрямую. Каждый файл читается и парсится best-effort — битый
 * или временно недоступный конфиг одного агента не должен блокировать подбор прокси остальным
 * (`JSON.parse` не через `loadAccountConfig`, чтобы не требовать заодно валидных apiId/apiHash/
 * sessionString — здесь важен только `proxy.username`).
 */
export function listUsedProxyUsernames(): Set<string> {
    const used = new Set<string>();
    for (const agentId of listAgentIds()) {
        try {
            const raw = fs.readFileSync(accountConfigPath(agentId), "utf-8");
            const cfg = JSON.parse(raw);
            if (cfg?.proxy?.username) used.add(String(cfg.proxy.username));
        } catch {
            // битый/отсутствующий конфиг — пропускаем, не блокируем подбор остальным
        }
    }
    return used;
}

export function channelsDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "tg-channels.db");
}

export function repliesDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "tg-replies.db");
}

export function dmThreadsDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "dm-threads.db");
}

export function joinQueueDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "tg-join-queue.db");
}

export function tasksDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "tasks.db");
}

export function llmLogDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "llm-log.db");
}

export function pendingReviewsDbPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "pending-reviews.db");
}

/** Папка tdata существующего агента — конвенция, совпадает с финальным
 *  расположением tdata у tg-agent-autoregistration (design.md D2 в
 *  openspec/changes/tg-agent-reauth-from-tdata). */
export function tdataPath(agentId: string): string {
    return path.join(workspaceDir(agentId), "tdata");
}

// ─── Конфигурация планировщика задач (task-scheduler) ─────────────────

/**
 * Granularity heartbeat-таймера агента, минуты. Источник истины для самого
 * значения — `deploy/systemd/tg-agent@.timer` (`OnCalendar=*:0/10`); эта
 * константа не генерирует systemd-юнит и не читает его — оба места нужно
 * менять синхронно вручную при смене тика (agent-schedule-offset design.md).
 * Используется вычислением дефолтной фазы старта задачи (round-robin по
 * агентам, `src/core/db/tasks.ts`).
 */
export const DISPATCHER_TICK_MINUTES = 10;

/**
 * Путь к БД воронки (funnel-tracking). Лежит в workspace админ-агента
 * (по умолчанию agent1) — он же получатель отчёта. Отдельного «трекинг-агента»
 * не заводим: один скрипт пишет сюда снапшоты и дневные агрегаты.
 */
export function funnelDbPath(adminAgentId: string): string {
    return path.join(workspaceDir(adminAgentId), "funnel.db");
}

/**
 * Путь к реестру discovery (channel-discovery). Общий на всю платформу, лежит в
 * workspace админ-агента (по умолчанию agent1) — тот же приём, что и funnel.db.
 * Хранит «какой канал уже известен» и «какому агенту назначен».
 */
export function discoveryDbPath(adminAgentId: string): string {
    return path.join(workspaceDir(adminAgentId), "discovery.db");
}

/**
 * Каталог CSV-отчётов анализа контента (channel-content-analysis). Лежит в
 * workspace админ-агента — артефакт уровня платформы (один прогон охватывает
 * нескольких агентов), тот же приём, что funnel.db / discovery.db. Имена файлов
 * несут UTC-timestamp, поэтому прогоны не перезатирают друг друга.
 */
export function reportsDir(adminAgentId: string): string {
    return path.join(workspaceDir(adminAgentId), "reports");
}

/**
 * Реестр персональных инвайт-ссылок в приватный канал (private-invite-links),
 * по одной ссылке на агента. Лежит в workspace админ-агента (по умолчанию
 * agent1) — тот же приём, что funnel.db/discovery.db: платформенные данные
 * в одном месте, независимо от того, чьей MTProto-сессией они наполняются
 * (создаёт ссылки REPORT_AGENT_ID).
 */
export function privateInvitesDbPath(adminAgentId: string): string {
    return path.join(workspaceDir(adminAgentId), "private-invites.db");
}

/**
 * Ограничения агентов (telegram-error-handling) — одна БД на всю платформу
 * (не per-agent), лежит в workspace админ-агента, тот же приём, что
 * funnel.db/discovery.db/private-invites.db. Одна строка на agentId; наличие
 * строки означает, что агент ограничен диспетчером.
 */
export function agentRestrictionsDbPath(adminAgentId: string): string {
    return path.join(workspaceDir(adminAgentId), "agent-restrictions.db");
}

// ─── Конфигурация discovery (channel-discovery) ───────────────────────

/**
 * Токен TGStat API для standalone-скрипта (`src/scripts/ops/discovery.ts`): из env
 * `TGSTAT_TOKEN`, иначе плейсхолдер. Скилл (`tg_discovery_run`) токен сюда НЕ берёт —
 * он читает его из конфига плагина (`api.pluginConfig.tgstatToken`), см. index.ts и
 * docs/configuration.md. Ядро токен в env не читает — он приходит параметром.
 */
export const TGSTAT_API_TOKEN = process.env.TGSTAT_TOKEN ?? "STUB_TGSTAT_TOKEN";

// ─── Конфигурация ревью-гейта (post-comment-review) ────────────────────

/**
 * Токен и id чата ревьюеров общего Bot API-бота — платформенный секрет
 * (один на платформу, не per-agent), тем же паттерном, что `ASOCKS_API_KEY`
 * (docs/configuration.md): из `~/.openclaw/secrets.env`, читается напрямую
 * из `process.env`, без dotenv-загрузки в коде (design.md решение 9).
 */
export const TELEGRAM_REVIEW_BOT_TOKEN = process.env.TELEGRAM_REVIEW_BOT_TOKEN ?? null;
export const TELEGRAM_REVIEW_CHAT_ID = process.env.TELEGRAM_REVIEW_CHAT_ID ?? null;

/**
 * География и язык поиска TGStat для RU-задачи (channels/search).
 * Значения по API TGStat: country — ISO-код `ru` (НЕ `russia`/`643`),
 * language — `russian` (НЕ `ru`). Проверено прямыми запросами к API.
 */
export const DISCOVERY_COUNTRY = "ru";
export const DISCOVERY_LANGUAGE = "russian";

// ─── Конфигурация мониторинга каналов (group-monitoring) ──────────────

/**
 * Номинальный период обхода канала монитором, секунды (72 часа). Единый
 * источник истины: и скилл `monitor` (отбор «назревших» каналов в
 * `getChannelsBatch`), и расчёт `activityRate` воронки (знаменатель —
 * `CHANNEL_CHECK_PERIOD_SECONDS / 3600`) берут это значение. Не дублировать
 * числом в нескольких местах — при смене периода менять только здесь.
 */
export const CHANNEL_CHECK_PERIOD_SECONDS = 259200;

/** TTL кэша среднего охвата канала: 30 дней в секундах. */
export const AVG_VIEWS_CACHE_TTL_SECONDS = 30 * 86400;

// ─── Конфигурация post-freshness-gate (monitor-v2) ────────────────────

/**
 * Период обхода канала для `monitor-v2` (R5), секунды (72 часа) — отдельная
 * константа от `CHANNEL_CHECK_PERIOD_SECONDS` (сейчас совпадает по значению, но
 * не переиспользует её: гейтятся разными бизнес-правилами, post-freshness-gate,
 * design.md — могут снова разойтись в будущем).
 */
export const MONITOR_V2_CHECK_PERIOD_SECONDS = 259200;

/** R1: первый (инициирующий) комментарий допустим, пока с публикации поста прошло менее этого. */
export const POST_FRESHNESS_FIRST_COMMENT_MAX_AGE_SECONDS = 24 * 3600;

/**
 * R2: продолжение диалога допустимо, пока с публикации поста прошло не больше этого.
 * Не переиспользует `THREAD_EXPIRE_SECONDS` из `monitor.ts` — там якорь другой
 * (последняя активность треда, не дата поста), совпадение величины (4 дня) случайно.
 */
export const POST_FRESHNESS_CONTINUATION_MAX_AGE_SECONDS = 4 * 86400;

/** TTL локального кэша даты публикации поста ветки: 30 дней в секундах. */
export const THREAD_POST_DATE_TTL_SECONDS = 30 * 86400;

// ─── Конфигурация приостановки канала при удалении сообщений (channel-suspend-on-deletion) ───

/** Окно проверки удалённых сообщений агента в канале: 14 дней в секундах. */
export const MESSAGE_DELETION_CHECK_WINDOW_SECONDS = 14 * 86400;

/** Порог числа удалённых сообщений агента за окно, после которого канал приостанавливается. */
export const MESSAGE_DELETION_THRESHOLD = 2;

/** Длительность приостановки канала (`status='suspend'`) при превышении порога удалений: 3 дня. */
export const CHANNEL_SUSPEND_DURATION_SECONDS = 259200;

// ─── Конфигурация channel-post-watch (monitor-v3) ──────────────────────

/**
 * Длительность `status = 'only_comment'` после успешного комментария к
 * посту: 2 суток. Не задаётся как `statusDurationSeconds` в
 * `markChannelStatus` (см. design.md, решение 3) — переход по истечении
 * делает сам `monitor-v3` (в `sleep`, не сразу в `NULL`), не общий механизм
 * `expireChannelStatuses`.
 */
export const CHANNEL_POST_WATCH_ONLY_COMMENT_SECONDS = 2 * 86400;

/**
 * Длительность `status = 'sleep'`, следующего за `only_comment`: 1 сутки
 * (итого 3 суток от исходного комментария). В отличие от `only_comment`,
 * задаётся как `statusDurationSeconds` — снимается общим механизмом
 * `expireChannelStatuses`, тем же, что уже применяется к
 * `banned`/`suspend`/`format_error`.
 */
export const CHANNEL_POST_WATCH_SLEEP_SECONDS = 1 * 86400;

// ─── Конфигурация channel-post-watch-v4 (monitor-v4) ───────────────────

/**
 * Таймзона, по которой monitor-v4 вычисляет границы целевого дня
 * (`сегодня−2 суток`, design.md решение 1) — та же, что уже задаёт каданс
 * `monitor-v3`/`monitor-v4` в `DEFAULT_PERIODIC_SCHEDULE` (core/db/tasks.ts).
 */
export const MONITOR_V4_TARGET_DAY_TZ = "Asia/Yekaterinburg";

// ─── Конфигурация group-monitoring-v5 (monitor-v5) ──────────────────────

/**
 * Период обхода канала для `monitor-v5` (design.md, Decision 5), секунды
 * (72 часа) — отдельная константа от `CHANNEL_CHECK_PERIOD_SECONDS` (сейчас
 * совпадает по значению, но физически отдельная, тот же приём, что уже
 * применён к `MONITOR_V2_CHECK_PERIOD_SECONDS` — версии могут разойтись по
 * периоду в будущем).
 */
export const MONITOR_V5_CHECK_PERIOD_SECONDS = 259200;

// ─── Конфигурация воронки (funnel-tracking) ───────────────────────────

/** Админ-агент: владелец funnel.db/discovery.db/reports/, права на приватный канал. */
export const FUNNEL_ADMIN_AGENT_ID = "agent1";

/**
 * Зарезервированный агент-получатель отчётов (funnel-report, daily-summary) —
 * независим от FUNNEL_ADMIN_AGENT_ID (владельца данных). Исключён из
 * listAgentIds() (см. выше) и не может быть запущен диспетчером
 * (dispatcher.ts) или поставлен в расписание (scheduler-control.ts) —
 * не выполняет рабочих задач, только получает отчёты в Saved Messages.
 */
export const REPORT_AGENT_ID = "agent27";

/**
 * ID приватного канала для подсчёта заявок на вступление (agent1 — админ).
 * Формат — как в get_dialogs / tg-channels.db (вид -100…). Захардкожен здесь
 * как единый источник истины: и инструмент tg_funnel_report, и скрипт-таймер
 * берут это значение (скрипт может переопределить аргументом --private-channel).
 */
export const FUNNEL_PRIVATE_CHANNEL_ID = "-1003698044714";

/** Общий каталог шаблонов персон: ~/.openclaw/personas/<personName>/ (agent-persona-template). */
export function personasRoot(): string {
    return path.join(os.homedir(), ".openclaw", "personas");
}

/**
 * Путь к SOUL.md шаблона персоны — читается заново на каждый прогон диспетчера,
 * не копируется в workspace агента (agent-persona-template). Персона агента
 * резолвится через поле `persona` в его tg-account.json.
 */
export function personaSoulPath(personName: string): string {
    return path.join(personasRoot(), personName, "SOUL.md");
}

// ─── Загрузка конфигурации аккаунта ───────────────────────────────────

/**
 * Читает и валидирует `tg-account.json` агента. Бросает Error с человекочитаемым
 * сообщением при отсутствии обязательных полей — вызывающая сторона
 * (плагин или диспетчер) превращает его в свой формат ошибки.
 */
/**
 * Флаг ручного review-gate агента (post-comment-review) — лёгкое чтение,
 * без полной валидации `AccountConfig` (apiId/apiHash/sessionString уже
 * проверены раньше по построению — `tg.loadAccount` успел отработать до
 * того, как monitor-v3 дойдёт до этой проверки). false при отсутствии поля
 * или самого файла.
 */
export function isReviewGateEnabled(agentId: string): boolean {
    try {
        const raw = fs.readFileSync(accountConfigPath(agentId), "utf-8");
        return JSON.parse(raw)?.reviewGateEnabled === true;
    } catch {
        return false;
    }
}

export function loadAccountConfig(agentId: string): AccountConfig {
    const configPath = accountConfigPath(agentId);
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);

    if (!cfg.apiId || !cfg.apiHash || !cfg.sessionString || !cfg.persona) {
        throw new Error("tg-account.json is missing required fields: apiId, apiHash, sessionString, persona");
    }

    let proxy: ProxyConfig | undefined;
    if (cfg.proxy) {
        const { type, host, port, username, password, name, countryCode, state, city } = cfg.proxy;
        if (!host || !port) {
            throw new Error("tg-account.json proxy is missing required fields: host, port");
        }
        proxy = {
            type: type === "socks4" ? "socks4" : "socks5",
            host: String(host),
            port: Number(port),
            username: username ? String(username) : undefined,
            password: password ? String(password) : undefined,
            name: name ? String(name) : undefined,
            countryCode: countryCode ? String(countryCode) : undefined,
            state: state ? String(state) : undefined,
            city: city ? String(city) : undefined,
        };
    }

    let device: DeviceConfig | undefined;
    if (cfg.device && typeof cfg.device === "object") {
        const d = cfg.device;
        device = {
            deviceModel:    d.deviceModel    ? String(d.deviceModel)    : undefined,
            systemVersion:  d.systemVersion  ? String(d.systemVersion)  : undefined,
            appVersion:     d.appVersion     ? String(d.appVersion)     : undefined,
            langCode:       d.langCode       ? String(d.langCode)       : undefined,
            systemLangCode: d.systemLangCode ? String(d.systemLangCode) : undefined,
        };
    }

    return {
        accountId: cfg.accountId ?? "default",
        apiId: Number(cfg.apiId),
        apiHash: String(cfg.apiHash),
        sessionString: String(cfg.sessionString),
        persona: String(cfg.persona),
        username: cfg.username ? String(cfg.username) : undefined,
        device,
        proxy,
        reviewGateEnabled: cfg.reviewGateEnabled === true,
    };
}

// ─── Человеческий ритм monitor-v5 (human-pacing) ──────────────────────
//
// Заменяет прежний машинный ритм: фиксированная пауза 1 сек между каналами,
// один общий запрос статуса на весь батч, мгновенная отправка ответа.
// Значения подобраны по замерам реального профиля (56% каналов пустые,
// медиана непрочитанных в активном канале — 1 сообщение): средняя цена
// канала ~45 сек, прогон на 20 каналов ~15 мин, худший случай ~40 мин
// (лимит юнита — 2 часа).

/** Мягкий суммарный потолок каналов за один прогон monitor-v5 (было 50 —
 * не влезало в лимит юнита), набирается волнами (V5_WAVE_MIN/MAX) — см.
 * monitor-v5-human-pacing-batching design.md Decision 3. */
export const V5_BATCH_LIMIT = 20;

/** Потолок уникальных каналов с реально отправленным сообщением за один
 * прогон monitor-v5 — по достижении прогон останавливается полностью, не
 * дожидаясь исчерпания V5_BATCH_LIMIT (monitor-v5-session-send-cap
 * design.md Decision 1-2). Считаются каналы, не отдельные сообщения. */
export const V5_SESSION_SEND_CAP = 3;

/** Пауза после канала, в котором было что читать, сек. */
export const V5_DELAY_ACTIVE_MIN_SEC = 20;
export const V5_DELAY_ACTIVE_MAX_SEC = 50;

/** Пауза после пустого канала («заглянул и закрыл»), сек. */
export const V5_DELAY_EMPTY_MIN_SEC = 8;
export const V5_DELAY_EMPTY_MAX_SEC = 20;

/** Суммарный потолок сообщений на канал за прогон (защита от аномального
 * backlog после простоя) — было лимитом одного вызова getMessages, теперь
 * канал читается чанками (V5_MSG_CHUNK_MIN/MAX). */
export const V5_GET_MESSAGES_LIMIT = 200;

/** Раз в сколько секунд (не чаще) monitor-v5 делает полную синхронизацию
 * списка каналов (listGroupChannels/syncChannels/cacheChannelIdentities). */
export const V5_FULL_SYNC_PERIOD_SECONDS = 86400;

/** Размер страницы при постраничном listGroupChannels и пауза между
 * страницами, сек. */
export const V5_SYNC_PAGE_SIZE = 100;
export const V5_SYNC_PAGE_DELAY_MIN_SEC = 4;
export const V5_SYNC_PAGE_DELAY_MAX_SEC = 7;

/** Размер волны при отборе назревших каналов (getChannelsBatch вызывается
 * повторно волнами случайного размера, пока не набран V5_BATCH_LIMIT) и
 * пауза после каждого вызова getChannelsBatch, сек. */
export const V5_WAVE_MIN = 10;
export const V5_WAVE_MAX = 15;
export const V5_WAVE_DELAY_MIN_SEC = 3;
export const V5_WAVE_DELAY_MAX_SEC = 10;

/** Размер чанка при чтении непрочитанных сообщений чата. */
export const V5_MSG_CHUNK_MIN = 7;
export const V5_MSG_CHUNK_MAX = 12;

/** Пауза между получением чанка сообщений и разметкой его прочитанным, сек. */
export const V5_MSG_MARK_DELAY_MIN_SEC = 1;
export const V5_MSG_MARK_DELAY_MAX_SEC = 7;

/** Пауза между последовательными чанками сообщений одного чата, сек. */
export const V5_MSG_CHUNK_DELAY_MIN_SEC = 7;
export const V5_MSG_CHUNK_DELAY_MAX_SEC = 15;

/** Индикатор «печатает…» перед отправкой ответа — единый диапазон, без
 * отдельной паузы «подумать» и без расчёта по скорости печати текста. */
export const V5_TYPING_MIN_SEC = 60;
export const V5_TYPING_MAX_SEC = 120;

/**
 * Случайный интервал между пробуждениями агента (human-pacing): вместо
 * жёсткого cron. При окне бодрствования 03:00-23:00 даёт 5-8 прогонов в
 * сутки и автоматически разносит агентов друг от друга.
 */
export const V5_WAKE_GAP_MIN_SEC = Math.round(2.5 * 3600);
export const V5_WAKE_GAP_MAX_SEC = 4 * 3600;

// ─── leave-banned-channels human pacing (leave-banned-human-pacing) ────
//
// Человекоподобный темп для leave-banned-channels: паузы между шагами
// resolve→leave, опциональное чтение батчей сообщений перед выходом,
// пауза между каналами. Отдельный префикс (не V5_*) — свои диапазоны,
// не общий словарь пацинга (осознанно, см. design.md Decision 6).

/** Лимит каналов на выход за один прогон. */
export const LEAVE_BANNED_BATCH_LIMIT = 20;

/** Пауза перед leaveChannel, сек — всегда. */
export const LEAVE_BANNED_PRE_LEAVE_DELAY_MIN_SEC = 10;
export const LEAVE_BANNED_PRE_LEAVE_DELAY_MAX_SEC = 20;

/** Пауза между обработкой каналов очереди, сек. */
export const LEAVE_BANNED_CHANNEL_DELAY_MIN_SEC = 2;
export const LEAVE_BANNED_CHANNEL_DELAY_MAX_SEC = 7;

/** Вероятность (0..1) опционального чтения сообщений перед выходом. */
export const LEAVE_BANNED_READ_GATE_PROBABILITY = 0.5;

/** Число батчей чтения, если гейт сработал. */
export const LEAVE_BANNED_READ_BATCHES_MIN = 1;
export const LEAVE_BANNED_READ_BATCHES_MAX = 3;

/** Размер одного батча сообщений. */
export const LEAVE_BANNED_MSG_BATCH_MIN = 7;
export const LEAVE_BANNED_MSG_BATCH_MAX = 15;

/** Пауза между батчами сообщений, сек (не после последнего). */
export const LEAVE_BANNED_MSG_BATCH_DELAY_MIN_SEC = 3;
export const LEAVE_BANNED_MSG_BATCH_DELAY_MAX_SEC = 7;
