# Экономика LLM при масштабировании: подписка vs локальная модель

Дата анализа: 2026-10-04. Цель масштаба: **100 агентов, 20 000 каналов**.
Порог качества для перехода на локаль: уровень **gpt-5.4-mini**.

Статус: аналитика для принятия решения. Вариант не выбран — решение за человеком.

## Вопрос

Сколько Plus-аккаунтов нужно для масштаба; сколько будет стоить переход на
локальную LLM; оправдан ли переход при текущих задачах и на какую модель.

## Методология (из индустрии)

- Единица эффективности — **cost per successful task** (суммарные затраты с
  ретраями / число ответов, прошедших порог качества), а не $/токен
  ([Cost Per Finished Task](https://medium.com/@reshtei/cost-per-finished-task-why-its-the-only-llm-cost-metric-that-survives-contact-with-production-a28860a72405),
  [wavect](https://wavect.io/blog/llm-cost-calculator-2026/)).
- TCO локали = фиксированное железо (GPU-аренда/покупка) + ops + электричество;
  у API — только переменная per-token. Решает коэффициент утилизации GPU: локаль
  выигрывает выше ~50% загрузки
  ([Cloudzy](https://cloudzy.com/blog/self-hosting-open-weight-llm-gpu-vps-cost/),
  [renezander](https://renezander.com/guides/self-hosted-llm-vs-api/)).
- Против бюджетного open-weight API (DeepSeek) self-hosting почти никогда не
  выигрывает по чистой цене
  ([spheron](https://www.spheron.network/blog/migrate-from-openai-api-to-self-hosted-llms-cost-2026/)).

## Исходные данные (VPS, окно 7 дней до 2026-10-04)

| Параметр | Значение | Источник |
|---|---|---|
| Активных агентов на monitor-v5 | 44 (из 205 каталогов) | `runs` |
| Единственный LLM-потребитель | **monitor-v5** (join-queue/leave-banned — 0; анализ каналов в `runs` не найден) | `runs.llmCalls` |
| Запросов к LLM сейчас | 840/сутки | `runs` |
| На агента | 19 запросов/сутки при 27 каналах | `runs` |
| **Ставка** | **0.70 запроса/сутки на канал** | расчёт |
| Промпт / ответ | 2 044 / 973 симв. | `llm_log` |
| Персона (`system`, в каждом вызове monitor-v5) | ~9 700 симв., **всего 2 варианта** (maria, irina) | `SOUL.md`, `src/skills/monitor-v5.ts:693,711` |
| Каналов в реестре сейчас | 1 744 | `discovery.db` |

Примечание: `llm_log.prompt` не содержит `system` (персона не логируется по
коду), поэтому реальный вход = промпт + персона.

### Оценка токенов

Допущение: ~2.5 символа/токен для кириллицы в современном токенизаторе
(диапазон 2–3 — главная неопределённость; на качественный вывод не влияет).

- Вход/запрос: (9 700 + 2 044)/2.5 ≈ **4 700 токенов** (из них ~3 900 — персона,
  кэшируемый префикс, всего 2 варианта на всех агентов).
- Выход/запрос: 973/2.5 ≈ **390 токенов**.

### Прогноз на цель (20 000 каналов = 200 канал/агент × 100 агентов)

- **≈14 000 запросов/сутки** (×16.7 к текущим 840).
- Вход ≈ 65.8M/сут, выход ≈ 5.5M/сут → **≈71M токенов/сут ≈ 2.1B/мес**.

## Вопрос 1 — Сколько Plus-аккаунтов

Лимит **GPT-6 Luna на Plus = 350–3 000 сообщений за 5-часовое окно**
([tokenkarma](https://tokenkarma.app/blog/openai-rate-limits-july-2026/),
[northflank](https://northflank.com/blog/chatgpt-usage-limits-free-plus-enterprise)).
В сутках 4.8 окна → ёмкость аккаунта 1 680 (низ) … 14 400 (верх) запросов/сутки.

При 14 000 запросов/сутки:
- консервативно (~350/5ч): 14 000 / 1 680 ≈ **9 аккаунтов**;
- оптимистично (3 000/5ч): ~1–2, но верхняя граница динамическая, не гарантирована.

**Планировать 8–10 Plus-аккаунтов**, стоимость ≈ 9 × $23 ≈ **~$207/мес**.

Фрагильность пути (важнее арифметики):
1. **Против ToS** — автоматический трафик 100 бот-аккаунтов через потребительскую
   подписку (сейчас один токен на всех, `src/llm/client.ts:120`).
2. **Лимиты/список моделей меняются односторонне** — уже было 08.09.2026 (у
   аккаунта урезали модели, весь LLM встал).
3. **Нужна ротация токенов** между N аккаунтов (design-doc
   `llm-multi-account-failover`) — инженерная работа.

## Вопрос 2 — Стоимость локальной LLM

**Модель под порог gpt-5.4-mini:** **Qwen3-32B** (Apache-2.0, 100+ языков включая
русский, нативный JSON/structured output;
[huggingface](https://huggingface.co/blog/daya-shankar/open-source-llm-models-to-run-locally),
[apxml](https://apxml.com/models/qwen3-32b)). Качество проверить на реальных
промптах monitor-v5 до решения.

**Железо:** FP8 ~32–36 ГБ → один **H100 80GB** с запасом под KV-кэш; INT4
(~16–22 ГБ) влезает в **L40S 48GB**/A100
([apxml](https://apxml.com/models/qwen3-32b),
[spheron](https://www.spheron.network/blog/run-qwen3-locally-gpu-requirements-2026/)).
Нагрузка по выходу ~64 ток/с в среднем — **одного GPU хватает на 100 агентов** с
батчингом vLLM; второй — резерв.

**Аренда 24/7** ([spheron](https://www.spheron.network/blog/gpu-cloud-pricing-comparison-2026/),
[synpix](https://www.synpixcloud.com/blog/cloud-gpu-pricing-comparison-2026)):

| GPU | $/час | $/мес |
|---|---|---|
| L40S (INT4) | ~$0.96 | ~$691 |
| A100 80GB (FP8) | ~$1.43 | ~$1 030 |
| H100 80GB (FP8) | ~$1.49–2.65 | ~$1 073–1 908 |

Плюс ~$200/мес ops + разовая миграция `client.ts` с codex на vLLM-эндпоинт.
Покупка H100 — $30–40k, окупаемость против аренды ~19+ мес
([intuitionlabs](https://intuitionlabs.ai/articles/nvidia-ai-gpu-pricing-guide),
[millionminer](https://millionminer.com/news/cloud-gpu-pricing-rent-vs-buy)).

**Итого локаль ≈ $700–1 400/мес** (1 GPU в аренду + ops).

## Ключевое сравнение — DeepSeek (уже подключён как fallback)

deepseek-flash: вход $0.15/1M (miss, off-peak), **$0.003/1M (cache-hit)**, выход
$0.60/1M ([morphllm](https://www.morphllm.com/deepseek-api),
[benchlm](https://benchlm.ai/deepseek/api-pricing)). Персона — 1 из 2 вариантов →
почти всегда cache-hit.

- Пессимистично (весь вход miss, off-peak): 65.8M×$0.15 + 5.5M×$0.60 ≈ **$395/мес**.
- Реалистично (персона в кэше): ≈ **$105–250/мес**, ноль железа, ноль ops, нет ToS-риска.

## Вопрос 3 — Нужен ли переход и на что

**По чистой экономике — нет.** При 14 000 запросов/сутки (вход-тяжёлый и
кэшируемый) бюджетный API (DeepSeek, уже в коде) дешевле и локали, и
мульти-аккаунтной подписки.

| Опция | $/мес на цель | Ops | ToS/риск | Приватность |
|---|---|---|---|---|
| DeepSeek primary | **~$105–400** | нет | нет | данные у 3-й стороны |
| Локаль Qwen3-32B (1×H100) | ~$700–1 400 | да | нет | полная |
| ~9 Plus-аккаунтов | ~$207 | ротация токенов | **высокий** (ToS, инцидент 08.09) | данные у 3-й стороны |

Переход на локаль оправдан **только не-ценовыми драйверами**: приватность (не
слать переписки Telegram во внешний API), независимость от односторонних
изменений (08.09), отсутствие ToS-риска. Если они важнее дельты ~$500–1 000/мес —
локаль, модель **Qwen3-32B** на 1×H100 через vLLM.

### Варианты (решение за человеком)

1. **Дёшево и минимум работы:** сделать DeepSeek-flash primary, уйти от
   зависимости от подписки. ~$105–400/мес, уже интегрировано.
2. **Максимум контроля/приватности:** локаль Qwen3-32B, 1 арендованный H100.
   ~$700–1 400/мес + миграция.
3. **Масштабирование на подписках** (~9 Plus + failover) — не рекомендуется:
   против ToS, хрупко (инцидент 08.09).

## Источники

- [Cost Per Finished Task — medium](https://medium.com/@reshtei/cost-per-finished-task-why-its-the-only-llm-cost-metric-that-survives-contact-with-production-a28860a72405)
- [LLM Cost Calculator 2026 — wavect](https://wavect.io/blog/llm-cost-calculator-2026/)
- [Self-host vs API cost math — Cloudzy](https://cloudzy.com/blog/self-hosting-open-weight-llm-gpu-vps-cost/)
- [Self-host vs API break-even — renezander](https://renezander.com/guides/self-hosted-llm-vs-api/)
- [Migrate to self-hosted vs budget API — spheron](https://www.spheron.network/blog/migrate-from-openai-api-to-self-hosted-llms-cost-2026/)
- [OpenAI rate limits July 2026 — tokenkarma](https://tokenkarma.app/blog/openai-rate-limits-july-2026/)
- [ChatGPT usage limits — northflank](https://northflank.com/blog/chatgpt-usage-limits-free-plus-enterprise)
- [DeepSeek API pricing — morphllm](https://www.morphllm.com/deepseek-api) · [benchlm](https://benchlm.ai/deepseek/api-pricing)
- [Qwen3-32B specs & VRAM — apxml](https://apxml.com/models/qwen3-32b) · [Run Qwen3 locally — spheron](https://www.spheron.network/blog/run-qwen3-locally-gpu-requirements-2026/)
- [Best open-weight LLMs 2026 — huggingface](https://huggingface.co/blog/daya-shankar/open-source-llm-models-to-run-locally)
- [GPU cloud pricing 2026 — spheron](https://www.spheron.network/blog/gpu-cloud-pricing-comparison-2026/) · [synpix](https://www.synpixcloud.com/blog/cloud-gpu-pricing-comparison-2026)
- [H100 price / rent vs buy — intuitionlabs](https://intuitionlabs.ai/articles/nvidia-ai-gpu-pricing-guide) · [millionminer](https://millionminer.com/news/cloud-gpu-pricing-rent-vs-buy)
