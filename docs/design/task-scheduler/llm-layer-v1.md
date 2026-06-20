# LLM-слой: вызов моделей с failover

> **О чём документ.** Как standalone-скрипты вызывают LLM для генерации текста
> (ответы в группах, DM, скоринг кандидатов) — на подписке ChatGPT Plus через
> Codex OAuth, с автоматическим переключением на другую модель при лимите.
>
> **Статус:** дизайн. Дополняет [architecture.md](./architecture.md) (раздел 6.4).
> **Формат:** Design Doc (RFC-style) — фиксирует выбор из рассмотренных вариантов.

---

## 1. TL;DR

Генерация текста уезжает из агента OpenClaw внутрь скриптов. Стек —
**Vercel AI SDK + `openai-oauth-provider` + `ai-fallback`**: один интерфейс
`generateText`/`generateObject`, primary-модель ходит на codex по подписке Plus
($0), при лимите/ошибке `ai-fallback` автоматически переключается на запасную
модель. Токен берётся из общего `auth.json`, рефреш и запись обратно в файл —
внутри библиотеки. Отдельный сервис-шлюз не нужен, самописного кода — минимум.

---

## 2. Контекст и проблема

Сейчас промпты исполняет LLM-агент OpenClaw (через системный промпт и function
calling). При переходе на standalone-скрипты ([architecture.md](./architecture.md))
агента-исполнителя нет — скрипту нужен прямой способ вызвать модель.

Где в скиллах нужна LLM:

| Скилл | Назначение вызова | Тип вывода |
|---|---|---|
| `dm-send` | сформулировать персональный DM | текст |
| `telegram-group-monitor` | ответ в треде / на сообщение | текст |
| `telegram-group-monitor` | темы обсуждения, релевантность персоне | текст |
| `telegram-group-monitor` | выбрать одно релевантное сообщение | JSON |
| `telegram-group-monitor` | скоринг сообщения для DM (0–1) | JSON |
| `dm-replies` | ответ на входящий DM | текст |

---

## 3. Требования

1. **codex через OAuth** — вызовы идут на подписке ChatGPT Plus, без потокенной
   оплаты за primary.
2. **Failover при лимите** — если codex упирается в лимит/ошибку, запрос
   автоматически уходит на другую модель.
3. **Автоматический рефреш токена** — без ручного вмешательства, включая
   сохранение обновлённого токена между запусками процессов.
4. **Общий `auth.json`** — один токен на всех агентов (общий пул лимита Plus).
5. **Персона из `SOUL.md`**, без системных промптов OpenClaw.
6. **Structured output** — валидируемый JSON для скоринга и выбора сообщений.

---

## 4. Рассмотренные варианты

| Вариант | Подписка Plus как primary | Failover | Отдельный сервис | Минусы |
|---|---|---|---|---|
| `codex exec` (shell к CLI) | да | нет (сам) | нет | оверхед агента, только OpenAI, процесс на вызов |
| reverse-eng HTTP (порт) | да | нет (сам) | нет | недокументированный эндпоинт, пишешь сам |
| OpenClaw `/v1/chat/completions` | да (костыль) | в доках нет | да (OpenClaw) | идёт через agent codepath = системный промпт; токены |
| Хостинговый шлюз (Vercel/OpenRouter) | **нет** | да (авто) | да (хостинг) | не умеет подписку Plus → primary платный |
| LiteLLM self-hosted | да (кастом upstream) | да | да (на VPS) | отдельный сервис, ручной refresh-setup |
| **AI SDK + openai-oauth-provider + ai-fallback** | **да** | **да (в коде)** | **нет** | неофиц. провайдер (риск эндпоинта) |

Подробный разбор — в истории решения; ключевые отсечения:

- **Хостинговый шлюз** не использует подписку Plus (звонит чужой сервис без
  OAuth-библиотеки) → primary становится платным. Противоречит требованию 1.
- **OpenClaw-эндпоинт** прогоняет запрос через агента (применяется системный
  промпт) и держит OpenClaw в зависимостях. Противоречит требованию 5.
- **LiteLLM** решает всё, но ценой отдельного сервиса — избыточно для текущего
  масштаба; оставлено как путь роста (раздел 10).

---

## 5. Решение

**Vercel AI SDK + `openai-oauth-provider` + `ai-fallback`.**

- `openai-oauth-provider` — провайдер AI SDK, ходит на codex по OAuth-токену.
- `ai-fallback` — оборачивает список моделей в одну; при ошибке primary зовёт
  следующую.
- `@ai-sdk/openai` (или другой провайдер) — запасная модель по API-key.

Закрывает все требования без отдельного сервиса; самописного — только тонкий
модуль `LlmClient` и каталог промптов.

```
Стек: ai + openai-oauth-provider + ai-fallback + @ai-sdk/openai
```

---

## 6. Детальный дизайн

### 6.1. Место в слоях

```
┌──────────────────────────────────────────────────────┐
│ Оркестрация скиллов (runDmSend, runMonitor, …)         │
│   llm.complete({ system: SOUL.md, prompt })            │
└───────────────────────┬────────────────────────────────┘
                        │ зависит только от интерфейса
┌───────────────────────▼────────────────────────────────┐
│ LlmClient  (тонкий модуль)                              │
│   createFallback([ codex(primary), openai(fallback) ])  │
└───────┬───────────────────────────────┬────────────────┘
        │ Plus, $0                       │ при 429/ошибке
┌───────▼─────────────────┐   ┌──────────▼────────────────┐
│ openai-oauth-provider    │   │ @ai-sdk/openai (API-key)   │
│ → codex/responses (OAuth)│   │ → api.openai.com           │
└──────────────────────────┘   └────────────────────────────┘
```

LLM-слой — отдельный уровень; оркестрация знает только интерфейс `LlmClient`.

### 6.2. Интерфейс

`ai-fallback` собирает провайдеров в одну модель, дальше — штатные функции
AI SDK:

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
  // shouldRetryThisError: (e) => isRateLimit(e),      // переключаться только на лимите
});

export const complete = (o: { system: string; prompt: string }) =>
  generateText({ model, ...o }).then((r) => r.text);

export const completeObject = <T>(o: { system: string; prompt: string; schema: any }) =>
  generateObject<T>({ model, ...o }).then((r) => r.object);
```

### 6.3. Провайдеры

- **Primary** — `openai-oauth-provider`, модель `gpt-5.4` (зависит от плана
  Codex), на подписке Plus, $0.
- **Fallback** — `@ai-sdk/openai` по `OPENAI_API_KEY`. Срабатывает только при
  ошибке primary, поэтому потокенная оплата — редкая.

### 6.4. Авторизация и токен

**Путь — общий файл на всех агентов** (требование 4), в своей папке, отдельно
от агентного `auth-profiles.json` OpenClaw:

```
~/.openclaw/
├── agents/<agentName>/agent/auth-profiles.json   ← OpenClaw, не трогаем
└── codex-auth/auth.json                          ← codex OAuth, LLM-слой
```

`LlmClient` указывает на него явно: `authFilePath: "/home/tg/.openclaw/codex-auth/auth.json"`.

**Первый логин** (создаёт `auth.json`):

```
1. codex login            # локально, нужен браузер; Codex CLI через npx, разово
2. scp -i ~/.ssh/vps_key ~/.codex/auth.json tg@<vps>:~/.openclaw/codex-auth/auth.json
```

Codex CLI нужен **только** для разового логина и **не устанавливается на сервер**
— в рантайме участвует лишь файл + `openai-oauth-provider`.

**Рефреш + write-back** (подтверждено исходником `openai-oauth-core`):

- при `ensureFresh: true` (дефолт) перед запросом проверяется access token;
- если протух — `refreshChatGptTokens()` (`grant_type=refresh_token` на token-
  эндпоинт);
- свежие токены пишутся обратно: `writeAuthFile(...)` с `last_refresh`.

Поэтому коротко живущий диспетчер работает корректно: каждый прогон обновляет и
**сохраняет** токен, следующий процесс читает свежий. Условие — файл
**записываемый** пользователем `tg`.

### 6.5. Персона

`SOUL.md` агента (`~/.openclaw/agents/<agentName>/agent/SOUL.md`) читается
оркестрацией и передаётся как `system`-сообщение — без системных промптов
OpenClaw:

```typescript
const soul = readFileSync(soulPathFor(agentId), "utf8");
await complete({ system: soul, prompt });
```

### 6.6. Каталог промптов

Все промпты скиллов собираются в одном модуле (`llm/prompts.ts`):

| Функция | Скилл/шаг | Вывод |
|---|---|---|
| `generateDM(ctx)` | dm-send 5a | текст |
| `generateThreadReply(history)` | monitor 5.4/5.5 | текст |
| `generateReply(msg)` | monitor 5.6.3 | текст |
| `extractTopics(messages)` | monitor 5.6.1 | текст |
| `selectRelevantMessage(messages)` | monitor 5.6.2 | JSON `{ id }` |
| `scoreForDM(message)` | monitor 5.8 | JSON `{ score, reason }` |
| `generateDmReply(thread)` | dm-replies | текст |

Текстовые → `complete()`, JSON → `completeObject()` со схемой `zod`.

### 6.7. Обработка ошибок и failover

- **Rate-limit (429) / ошибка primary** → `ai-fallback` зовёт следующую модель.
  Через `shouldRetryThisError` можно сузить до «только лимит», чтобы не
  маскировать прочие ошибки.
- **Сбой авторизации** (refresh token истёк) → вызов codex падает →
  `ai-fallback` уходит на запасную. Система не встаёт; codex возвращается после
  повторного `codex login`.
- **Невалидный JSON** в structured-выводе → повтор/ошибка на уровне
  `generateObject`.

---

## 7. Сквозные аспекты

### 7.1. Лимиты / квота Plus

Общий `auth.json` = **один аккаунт ChatGPT = общий пул лимита** (Plus: 15–80
сообщений GPT-5.5 за 5-часовое окно на всех агентов). При росте числа агентов и
частоте вызовов (скоринг каждого сообщения, каждый DM) пул исчерпывается — тогда
включается fallback (платный). Это осознанный компромисс ради простоты; если
нужны раздельные пулы — папка `auth.json` на агента (требует отдельных аккаунтов)
или переход на LiteLLM (раздел 10).

### 7.2. Безопасность

- `auth.json` — **plaintext-токен** с полными правами аккаунта. Права на файл —
  только пользователь `tg` (`chmod 600`), папка `codex-auth/` — `700`.
- Файл должен быть записываемым (write-back рефреша) — `rw` для владельца.
- `OPENAI_API_KEY` фолбэка — через systemd `Environment=` / защищённый `.env`.

---

## 8. Операционка

**Зависимости:**
```bash
npm i ai openai-oauth-provider ai-fallback @ai-sdk/openai zod --ignore-scripts
```
(чистый JS, нативной сборки нет — совместимо с правилом `--ignore-scripts`.)

**Первый запуск:** `codex login` локально → `scp` файла в `~/.openclaw/codex-auth/`
→ выставить права → задать `OPENAI_API_KEY` в окружении сервиса.

**Re-login:** только при полном протухании сессии (~8 дней простоя) или отзыве
доступа. Частый heartbeat диспетчера держит токен свежим.

---

## 9. Риски и открытые вопросы

- **Недокументированный эндпоинт.** `codex/responses` — не публичный API, может
  измениться. Митигация: провайдер изолирован за `LlmClient`, замена —
  одна строка.
- **ToS-серая зона.** Программное использование подписки и пулинг аккаунтов
  могут нарушать политики OpenAI — учитывать при масштабировании.
- **`generateObject` на codex-провайдере** не гарантирован (в доках явно не
  заявлен). Если structured-режим через codex не заведётся — роутить JSON-вызовы
  на fallback-провайдер либо парсить JSON из `complete()` вручную.
- **Cloudflare-challenge** на codex-эндпоинте (известная проблема у LiteLLM) —
  проверить, не затрагивает ли `openai-oauth-provider`.

---

## 10. Будущее

При росте числа агентов и потребности в раздельных квотах / наблюдаемости —
переезд на **LiteLLM как сервис**: codex-upstream + fallback-список в конфиге
прокси, рефреш непрерывный (долго живущий процесс). Бизнес-логика и каталог
промптов не меняются — `LlmClient` начинает ходить на локальный LiteLLM-эндпоинт
вместо прямого провайдера.