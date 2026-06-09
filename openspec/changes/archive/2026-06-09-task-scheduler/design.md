## Context

Сейчас задачи `telegram-group-monitor`, `dm-send`, `dm-replies`, `account-warmup`, `join-queue` выполняет LLM-агент OpenClaw по cron. Агент на каждом прогоне ходит по десяткам инструментов — это дорого по токенам, хотя логика детерминирована, а LLM нужна только для генерации текста. Логика переносится в standalone TypeScript-скрипты, запускаемые systemd напрямую; OpenClaw остаётся тонким пультом управления расписанием.

Полный дизайн зафиксирован в `docs/task-scheduler/`: `requirements.md` (что и по каким правилам, R-*), `architecture.md` (как реализовано), `llm-layer.md` (LLM-слой).

## Обзор решения

**Один systemd-юнит на агента — диспетчер.** Юнит `tg-agent@<agentId>.service` запускает `dispatcher.ts`, который по БД определяет, какие задачи агента назрели, и выполняет их последовательно в одном процессе.

### Ключевой принцип: очередь принадлежит агенту, а не типу задачи

Вывод из ограничения «1 задача на агента». Раз ресурс (сессия Telegram) общий для всех задач агента, точка сериализации одна — на агента. Все типы задач проходят через один диспетчер, поэтому параллельных задач внутри агента не бывает по построению, без внешних локов. Это паттерн Actor Model (актор = агент, mailbox = очередь запусков) и Kafka partitioning (ключ = `agentId`): сериализация по ключу, параллелизм между ключами.

```
┌──────────────────────────────────────────────────────────┐
│  tg-agent@agent1.timer   (heartbeat, напр. каждые 10 мин) │
│  tg-agent@agent2.timer   (heartbeat, сдвинут RandomizedDelaySec) │
└──────────┬───────────────────────┬───────────────────────┘
           │ start-job             │ start-job
┌──────────▼──────────┐  ┌─────────▼───────────┐
│ tg-agent@agent1     │  │ tg-agent@agent2     │   ← параллельно
│  dispatcher.ts      │  │  dispatcher.ts      │
│   читает tasks (БД) │  │   читает tasks (БД) │
│   → monitor         │  │   → dm-send         │
│   → dm-send         │  │                     │
│  (последовательно)  │  │                     │
└──────────┬──────────┘  └─────────────────────┘
           │ stdout
┌──────────▼──────────────────────────────────┐
│  journald → journalctl -u tg-agent@agent1   │
└──────────────────────────────────────────────┘

Все юниты входят в slice tg-agents.slice (общие лимиты ресурсов).
```

## Структура каталогов

```
src/
├── core/                     # чистое ядро, без импортов OpenClaw
│   ├── telegram/             # MTProto: connect, dialogs, messages, send, reply, peerCache
│   ├── db/                   # channels, dm-threads, join-queue, replies, tasks
│   ├── config.ts             # загрузка tg-account.json, пути к данным
│   └── logger.ts             # интерфейс Logger { info, warn, error }
│
├── llm/                      # LLM-слой
│   ├── client.ts             # LlmClient: codex primary + fallback
│   └── prompts.ts            # каталог промптов
│
├── skills/                   # оркестрация — портированная логика скиллов (R-B2)
│   ├── monitor.ts            # runMonitor
│   ├── dm-send.ts            # runDmSend
│   ├── dm-replies.ts         # runDmReplies
│   ├── account-warmup.ts     # runAccountWarmup
│   └── join-queue.ts         # runJoinQueue (конечная, R-A3)
│
├── scripts/
│   └── dispatcher.ts         # точка входа: --agent <id>; создаёт схему tasks
│
└── index.ts                  # OpenClaw-плагин — тонкая обёртка над core/

deploy/
└── systemd/
    ├── tg-agent@.service
    ├── tg-agent@.timer
    └── tg-agents.slice
```

- `core/` и `llm/` не знают про планировщик и OpenClaw.
- `skills/` — сегодняшние `SKILL.md`, переписанные в код (R-B2), зовут `core/` и `llm/`.
- `dispatcher.ts` выбирает назревшие задачи и вызывает нужный `skills/*`.
- `index.ts` остаётся обёрткой над `core/` — без второй копии логики.

## Диспетчер `dispatcher.ts`

Точка входа на агента. Запускается как `dispatcher.ts --agent <agentId>`.

```
0. создать схему tasks, если её нет (идемпотентно)
1. загрузить tg-account.json агента
2. SELECT задачи где enabled=1 AND nextRun <= now()   ← что назрело
3. если пусто → выйти (за секунду, токены не тратятся)
4. connect к Telegram (один клиент на весь прогон)
5. для каждой назревшей задачи последовательно:
      выполнить (monitor / dm-send / dm-replies / …)
      сформировать статус-модель, отправить отчёт в Saved Messages   (R-D1)
      UPDATE lastRun = now(),
             nextRun = cron-parser(schedule, tz).next()              (R-D1: всегда)
      если задача вернула терминальный статус → enabled = 0          (R-A3)
6. disconnect, выйти
```

Один процесс на прогон — поэтому параллельных задач агента не существует.

## Таблица расписания `tasks`

Хранит расписание в БД, а не в таймере. Поле `schedule` — cron-выражение + `tz` (R-A1). Схему создаёт диспетчер при старте.

```
agentId | type       | schedule     | tz                 | lastRun | nextRun  | enabled
--------|------------|--------------|--------------------|---------|----------|--------
agent1  | monitor    | 0 */3 * * *  | Asia/Yekaterinburg | 12:00   | 15:00    | 1
agent1  | dm-send    | 0 14 * * *   | Asia/Yekaterinburg | 14:00   | next 14:00 | 1
agent1  | dm-replies | */30 * * * * | Asia/Yekaterinburg | 12:00   | 12:30    | 1
```

Уникальность по `(agentId, type)`; выборка по `(enabled, nextRun)`. После каждой задачи диспетчер пересчитывает срок: `nextRun = cronParser.parseExpression(schedule, { tz, currentDate: now }).next()`. Лежит в `~/.openclaw/workspace-<agentId>/tasks.db`. Существующие cron-расписания переносятся 1:1.

## systemd: сервис + таймер + slice

```ini
# tg-agent@.service  — шаблон, %i = agentId
[Service]
Type=oneshot
ExecStart=/usr/bin/npx tsx /opt/tg/current/scripts/dispatcher.ts --agent %i
Slice=tg-agents.slice
TimeoutStartSec=3600       # потолок времени прогона — 1 час (R-D1)

# tg-agent@.timer  — heartbeat
[Timer]
OnCalendar=*:0/10          # проверять каждые 10 минут
RandomizedDelaySec=60      # разнести старты агентов во времени

# tg-agents.slice  — общие лимиты на всех агентов
[Slice]
CPUQuota=60%
MemoryMax=1G
ConcurrencySoftMax=4       # одновременно не более 4 диспетчеров
```

На диске — три файла, независимо от числа агентов (шаблоны, `@` в имени). Под агента создаётся не файл, а инстанс шаблона (`systemctl enable --now tg-agent@agent1.timer`). Эти три файла — инфраструктура сервера, не часть релиза кода; `daemon-reload` нужен только при изменении самих шаблонов.

## OpenClaw-скилл — пульт управления

Скилл не запускает задачу напрямую. Он управляет строками в `tasks` и включает/выключает heartbeat-таймер агента:

```sql
INSERT INTO tasks (agentId, type, schedule, tz, nextRun, enabled)
VALUES ('agent1', 'dm-send', '0 14 * * *', 'Asia/Yekaterinburg', <calc>, 1)
ON CONFLICT(agentId, type) DO UPDATE SET schedule=excluded.schedule, enabled=1;
```

- Первая задача агента → дополнительно `systemctl enable --now tg-agent@agent1.timer`.
- Вторая задача тому же агенту → только INSERT (таймер уже крутится).
- Немедленный прогон → `UPDATE ... SET nextRun='now'` + `systemctl start tg-agent@<agentId>.service`.
- Не осталось активных задач → `systemctl disable --now ...timer`.

## Поведение во времени

- **Плановый прогон:** timer → start-job → сервис свободен → диспетчер стартует → назревшая задача выполняется → отчёт → сдвиг `nextRun` → выход.
- **Перекрытие прогонов:** тик попадает в занятый сервис → job встаёт в очередь systemd → следующие тики COALESCING (слияние). Очередь к агенту всегда максимум 1 — реализация ограничения «очередь, не пропуск» средствами systemd, без `flock`.
- **Выбор интервала heartbeat:** интервал таймера — granularity планирования, не период задач. Правило: тик мельче самого короткого периода задачи (минимум `dm-replies` — 30 мин, тик 10 мин достаточен).
- **Внеплановый запуск из Telegram:** скилл `UPDATE tasks SET nextRun='now'` + `systemctl start`. Свободен → стартует сразу; занят → коалесцируется и выполнит после текущего прогона.
- **Завершение, краш, таймаут:** `Type=oneshot`. Нормальное завершение (success или error) — `nextRun` сдвинут (R-D1), повтора в этот срок нет. Краш или таймаут (`TimeoutStartSec`, 1 ч) — процесс умер до `UPDATE`, `nextRun` не сдвинут, задача осталась назревшей и выполнится на следующем тике. Повтор не задваивает работу: модель идемпотентна между запусками.

## Сквозные аспекты

- **Сериализация:** внутри прогона задачи последовательны (одна сессия); между прогонами systemd job coalescing не даёт второй экземпляр юнита. Внешний лок не нужен.
- **Логирование:** приложение пишет в stdout (12-factor); systemd направляет в journald с тегом юнита. Три канала: логи (journald) ≠ отчёт (Saved Messages, R-D1) ≠ команды (чат с ботом). Внутри `core/` — инжектируемый интерфейс `Logger`.
- **Контроль ресурсов:** все агенты в `tg-agents.slice` — `CPUQuota`/`MemoryMax` (потолок группы), `ConcurrencySoftMax=N` (встроенный семафор), `RandomizedDelaySec` разносит старты.

## Архитектурные решения (ADR)

### Почему systemd, а не cron
cron не имеет понятий лока и очереди: каждый тик форкает процесс вслепую, перекрытия исполняются параллельно. systemd даёт single-instance (coalescing), очередь job'ов и логирование (journald) из коробки.

### Почему диспетчер, а не «юнит на задачу» + flock
Альтернатива (юнит на тип задачи + общий `flock`) даёт очередь в ядре без гарантии порядка и рост числа «спящих» процессов в `activating`. Диспетчер убирает flock: один процесс на агента, очередь — нативный systemd job queue (max 1).

### Почему не Redis / BullMQ / Kafka / Celery сейчас
BullMQ + Redis — готовый job queue, но требует Redis; оправдан при 20+ агентах (целевой путь миграции). Kafka — потоковая обработка, оверкилл. Celery — Python; проект на TS. Для масштаба < 20 агентов systemd dispatcher покрывает требования без зависимостей.

### Почему возим исходники, а не бинарник
`better-sqlite3` нативный — `.node` нельзя вшить, ставится на сервере отдельно. Возим исходники (`core/` + `skills/` + `scripts/`), запуск через `tsx`.

### Почему расписание в БД (cron-выражение), а не в таймерах / `intervalSec`
Один `.timer` триггерит один `.service` — разные периоды в одном таймере не описать. Периоды в `tasks` + heartbeat решают это. cron-выражение (а не `intervalSec`) нужно, т.к. есть календарные расписания (`dm-send` `0 14 * * *`), которые `intervalSec` выразил бы с дрейфом (R-A1).

## LLM-слой

**Vercel AI SDK + `openai-oauth-provider` + `ai-fallback`.** Один интерфейс `generateText`/`generateObject`; primary-модель ходит на codex по подписке Plus ($0); при лимите/ошибке `ai-fallback` автоматически переключается на запасную модель. Токен берётся из общего `auth.json`, рефреш и запись обратно в файл — внутри библиотеки. Отдельный сервис-шлюз не нужен.

```typescript
// llm/client.ts
import { generateText, generateObject } from "ai";
import { createFallback } from "ai-fallback";
import { createOpenAIOAuth } from "openai-oauth-provider";
import { createOpenAI } from "@ai-sdk/openai";

const codex    = createOpenAIOAuth({ authFilePath: CODEX_AUTH_PATH });
const fallback = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const model = createFallback({
  models: [ codex("gpt-5.4"), fallback("gpt-4o") ],   // порядок: primary, fallback
});

export const complete = (o: { system: string; prompt: string }) =>
  generateText({ model, ...o }).then((r) => r.text);

export const completeObject = <T>(o: { system: string; prompt: string; schema: any }) =>
  generateObject<T>({ model, ...o }).then((r) => r.object);
```

- **Авторизация:** общий файл `~/.openclaw/codex-auth/auth.json` на всех агентов, отдельно от агентного `auth-profiles.json` OpenClaw. Первый логин — `codex login` локально + `scp` файла на VPS. Рефреш + write-back при `ensureFresh: true`: протухший access token обновляется `refreshChatGptTokens()` и пишется обратно. Условие — файл записываемый пользователем `tg`.
- **Персона:** `SOUL.md` агента читается оркестрацией и передаётся как `system`-сообщение, без системных промптов OpenClaw.
- **Каталог промптов** (`llm/prompts.ts`): `generateDM`, `generateThreadReply`, `generateReply`, `extractTopics`, `selectRelevantMessage` (JSON), `scoreForDM` (JSON), `generateDmReply`. Текстовые → `complete()`, JSON → `completeObject()` со схемой `zod`.
- **Failover:** rate-limit (429) / ошибка primary → `ai-fallback` зовёт следующую модель; сбой авторизации → уход на запасную; невалидный JSON → повтор/ошибка на уровне `generateObject`.

## Риски и открытые вопросы

- **Версия systemd.** `ConcurrencySoftMax` появился в systemd 261 — проверить версию; если старее, ограничивать через `CPUQuota` слайса.
- **Долгий прогон дольше периода.** При прогоне регулярно длиннее интервала задача начнёт «отставать» (coalescing спасает от наложения) — нужен мониторинг длительности.
- **Недокументированный эндпоинт.** `codex/responses` — не публичный API, может измениться; провайдер изолирован за `LlmClient`, замена — одна строка.
- **ToS-серая зона.** Программное использование подписки и пулинг аккаунтов могут нарушать политики OpenAI.
- **`generateObject` на codex-провайдере** не гарантирован — при сбое роутить JSON-вызовы на fallback-провайдер либо парсить JSON вручную.
- **Cloudflare-challenge** на codex-эндпоинте — проверить, не затрагивает ли `openai-oauth-provider`.
- **Лимиты / квота Plus.** Общий `auth.json` = один аккаунт = общий пул лимита; при исчерпании включается fallback (платный) — осознанный компромисс ради простоты.
- **Окно диалогов `limit: 100` (peerCache).** `getDialogs`/`getDmDialogs` берут только первые 100 диалогов и из них наполняют `peerCache`. Диалоги за пределами топ-100 молча пропускаются: monitor/account-warmup/dm-replies действуют лишь по возвращённому множеству (краша нет, но «хвост» не обрабатывается за прогон), а dm-send при промахе по `sourceChatId` кандидата из БД ловит `No InputPeer cached` и отбрасывает кандидата (skip, не краш). Для аккаунта в >100 чатах (а join-queue массово вступает в группы) часть каналов/личек/кандидатов не обрабатывается. Прямое решение — забирать ВСЕ диалоги через пагинацию (`iterDialogs`) в `getDialogs`/`listGroupChannels`/`getDmDialogs`; пока не реализовано (зафиксировано как известное ограничение, см. комментарии в `core/telegram/service.ts`).

## Migration / Дисциплина перехода

- Пока агент не переведён полностью — он обслуживается ЛИБО OpenClaw, ЛИБО скриптами, не обоими (иначе два клиента на одной сессии).
- **Код** — заливать в любой момент; идущий процесс доработает на старом, новый подхватится следующим запуском.
- **Библиотеки** — `npm install` нельзя при работающем воркере (подмена нативного `.node` → краш); ставить в окно простоя.
- **Приём** — релизы в папки с датой + атомарный симлинк `current`; откат = вернуть симлинк.
- **Путь на BullMQ при росте:** бизнес-логика (`core/`, `skills/`) не трогается; меняется слой «как задача попадает в диспетчер»: systemd timer → BullMQ repeat-jobs, `tasks` → очередь Redis с `globalConcurrency: 1`. Триггеры: видимость очереди, retry с backoff, агентов 20+.
