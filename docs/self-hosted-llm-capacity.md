# Ёмкость self-hosted LLM: методология расчёта нагрузки

Дата анализа: 2026-10-04. Статус: методология + расчёт на реальных данных.
Решение о переходе и выборе модели — за человеком (см. ниже).

Этот документ отвечает на вопрос **«какая нагрузка ляжет на собственный
инференс-сервер и как её посчитать»** — то есть сайзинг железа (VRAM,
пропускная способность, одновременность). Он **дополняет**
[llm-economics-scaling-analysis.md](llm-economics-scaling-analysis.md), который
считает **стоимость** (TCO, cost-per-task, число Plus-аккаунтов) и выбирает
модель-кандидата. Числа по нагрузке (запросов/сутки, размеры промпта) берутся
оттуда и здесь не переписываются (один факт — один дом); здесь добавлены
одновременность, длительность прогонов и вывод формул ёмкости.

## Две метрики задержки

- **TTFT (Time To First Token)** — время от отправки запроса до первого токена
  ответа: длительность фазы **prefill** (обработка всего входного промпта) плюс
  ожидание в очереди. Растёт с длиной входа и с нагрузкой. Упирается в FLOPs
  GPU (compute-bound).
- **TPOT (Time Per Output Token)**, он же **ITL** — средний интервал между
  соседними токенами на фазе **decode** (генерация ответа). Упирается в
  пропускную способность памяти GPU (bandwidth-bound), деградирует с ростом
  одновременности.

Полное время ответа: `E2E ≈ TTFT + TPOT × число_выходных_токенов`
([hivenet](https://www.hivenet.com/post/llm-inference-metrics-ttft-tps),
[tianpan](https://tianpan.co/blog/2026-03-10-llm-latency-decomposition-ttft-vs-throughput)).

Prefill и decode упираются в разные ресурсы, поэтому их всегда разделяют при
сайзинге.

## Четыре величины нагрузки

Нагрузку на инференс-сервер нельзя описать одним «запросов в секунду». Она
раскладывается на:

1. **Частота** — запросов/сутки и пик по времени.
2. **Распределение длин** входа и выхода (p50/p95/max) — отдельно, потому что
   вход нагружает prefill, выход — decode.
3. **Одновременность (concurrency)** — число одновременных in-flight запросов;
   главный драйвер объёма KV-cache в VRAM.
4. **Паттерн прибытия** — равномерный или всплесками (burst).

## Выбор методологии: throughput/cost, не latency-SLO

| | Latency-SLO (дефолт чат-сервисов) | Throughput/cost (наш случай) |
|---|---|---|
| Оптимизирует | p95 TTFT/TPOT под нагрузкой, «колено» кривой | токены/с на доллар, утилизация GPU |
| Применима когда | есть интерактивный пользователь, жёсткий SLA задержки | нет человека в цикле, burst гасится очередью |
| Связывающее ограничение | TTFT-SLA | VRAM под пик concurrency + суточная пропускная способность |

У платформы **нет человека, синхронно ждущего ответа LLM**: все потребители —
фоновые скиллы по расписанию (`monitor-v5` раз в 3 ч, round-robin по агентам).
Поэтому TTFT/TPOT — мягкие ограничения, и правильная методология —
**throughput/cost с очередью**: сайзим железо под средний offered load в активном
окне плюс пик одновременности, а не под латентностный SLA. Если появится
синхронный путь (ручной тул в OpenClaw-плагине, где оператор ждёт ответа) — для
него методология переключается на latency-SLO.

## Три шага расчёта

### Шаг 1. Характеризация нагрузки (из `runs.db`/`llm_log`, провайдеронезависимо)

Источники данных в проекте:
- `runs.db` (`src/core/db/runs.ts`): на каждый прогон — `llmCalls`, `durationMs`,
  `cpuUserMs/cpuSystemMs`, `status`, `startedAt`, `type`. С 2026-10-04 добавлены
  `inputTokens/outputTokens/totalTokens` (расход токенов `ai-sdk`, снимается
  диспетчером как дельта `llm.tokenUsage` вокруг скилла) — ground truth по
  токенам для **всех** скиллов по мере накопления.
- `llm_log` (`src/core/db/llm-log.ts`): полный текст промпта и ответа, но только
  для `monitor-v3/v4/v5` и `channel-context`. До накопления `runs.*Tokens` длины
  считаются прогонкой этого текста через токенизатор целевой модели.

### Шаг 2. VRAM-сайзинг под модель-кандидата

```
VRAM = веса + KV_cache_пик + overhead(~10–20%)

веса         = P × b                             # P параметров, b байт/параметр (FP16=2, FP8=1, INT4=0.5)
KV_на_токен  = 2 × L × H_kv × D × b_kv            # 2 = K и V; L слоёв, H_kv KV-голов (после GQA), D head_dim
KV_cache_пик = KV_на_токен × S_p95 × M            # S_p95 — p95 (вход+выход) токенов, M — пик одновременных запросов
```

KV-cache не уменьшается при квантовании весов и при длинном контексте может
доминировать; поэтому его считают прямо, а не как процент от весов
([digitalapplied](https://www.digitalapplied.com/blog/how-much-vram-run-llm-quantization-kv-cache-context-2026),
[spheron VRAM](https://www.spheron.network/blog/gpu-memory-requirements-llm/)).

### Шаг 3. Проверка пропускной способности под расписание

```
нужно: суточные_output_токены / секунды_активного_окна ≤ устойчивый decode (ток/с)
       суточные_input_токены  / секунды_активного_окна ≤ устойчивый prefill (ток/с)  # с учётом prefix cache на статической части
```

Если среднесуточный поток укладывается в пропускную способность одной GPU — её
достаточно, очередь закрывает burst. Иначе число реплик =
`offered_load / пропускная_способность_на_GPU`. Перевод частоты и задержки в
число in-flight-слотов — закон Литтла: `concurrency = arrival_rate × service_time`.

### Prefix caching — главный рычаг для нашего профиля

Промпт `monitor-v5` — это ~3 900 токенов статической персоны (один из 2
вариантов: maria, irina), одинаковой в каждом вызове, плюс ~800 токенов
динамического хвоста (пост+комментарии) и короткий выход. Automatic prefix
caching (vLLM/TGI) хранит KV общего префикса один раз и переиспользует его,
превращая повторный prefill персоны в чтение из памяти и срезая TTFT на 60–80%
на таком общем системном промпте
([vLLM docs](https://docs.vllm.ai/en/v0.8.1/design/automatic_prefix_caching.html),
[spheron prefix](https://www.spheron.network/blog/prefix-caching-explained-why-repeated-prompts-get-cheaper-to/)).
Для платформы это не теоретический выигрыш, а основной: всего 2 варианта
префикса на всех агентов.

## Результаты на реальных данных

Окно 14 дней до 2026-10-04, агрегат по 190 `workspace-*/tasks.db` (прогоны были у
49 агентов), `src/core/db/runs.ts`.

### Шаг 1 — нагрузка

| Параметр | Значение | Источник |
|---|---|---|
| Единственный потребитель LLM | **monitor-v5** (join-queue, leave-banned — 0 `llmCalls`) | `runs` |
| Запросов к LLM | **739/сутки** (10 345 за 14 дней) | `runs.llmCalls` |
| `llmCalls` на прогон | p50=**0**, p90=13, p95=**23**, max=**73** | `runs` |
| Длительность прогона `monitor-v5` | p50=**95 с**, p90=942 с, p95=**1 586 с (~26 мин)**, max=85 мин | `runs.durationMs` |
| Прогонов дольше 10 мин | **393 / 2 446 (16%)** | `runs.durationMs` |
| Пик одновременных прогонов | **9** (p95 по времени = 3) при потолке `C=16` | расчёт (sweep-line) |
| Стартов `monitor-v5` за 10-мин тик | p95=4, max=13 | `runs.startedAt` |
| Вход / выход на запрос | **≈4 700 / ≈390 токенов** (из них ~3 900 — персона, кэшируемый префикс) | [llm-economics-scaling-analysis.md](llm-economics-scaling-analysis.md) |

Выводы шага 1:
- `llmCalls/run` p50=0 — большинство прогонов не делают ни одного вызова LLM
  (нет повода комментировать); нагрузка приходит **всплесками внутри прогона**
  (до 73 вызовов), а не ровным потоком.
- Пик одновременности прогонов — **9**, заметно ниже `C=16`. Одновременных
  LLM-запросов не больше, чем прогонов в LLM-фазе, то есть **≤ 9, p95 ≈ 3**.
- **Допущение «< 10 мин на прогон» из [task-scheduling.md](task-scheduling.md)
  (§Рабочие допущения) не подтверждается**: 16% прогонов `monitor-v5` дольше 10
  минут (p95 ≈ 26 мин). Длинный хвост — это преимущественно ожидания MTProto и
  rate-limit, а не время GPU; но для модели ёмкости диспетчера (п.2 §Причины
  очереди) это открытый вход, который теперь закрыт данными.

### Шаги 2–3 — отложены до выбора модели

Расчёт VRAM (шаг 2) и проверка пропускной способности под расписание (шаг 3)
зависят от выбранной модели: числа параметров `P` (вес в VRAM) и архитектуры
`L / H_kv / D` (KV-cache). Формулы приведены выше в §«Три шага расчёта»; числа
будут подставлены после того, как модель выбрана. Нагрузка (шаг 1) от модели не
зависит и уже посчитана — это и есть вход для шагов 2–3.

Варианты моделей и их стоимость — в
[llm-economics-scaling-analysis.md](llm-economics-scaling-analysis.md). Выбор
модели — за человеком.

## Методика получения чисел (воспроизводимость)

1. Серверный агрегат по всем `~/.openclaw/workspace-*/tasks.db`:
   `SELECT agentId, type, startedAt, durationMs, status, llmCalls FROM runs
   WHERE startedAt >= <cutoff>` → CSV.
2. Локальный расчёт (sweep-line по интервалам `[startedAt, startedAt+durationMs]`
   для одновременности; перцентили по `durationMs`/`llmCalls`; бакеты по 600 с
   для пика на тик).
3. Длины токенов — из `runs.inputTokens/outputTokens` по мере накопления (после
   деплоя изменения от 2026-10-04), до того — токенизатором по `llm_log`.

## Источники

- [TTFT/TPS метрики — hivenet](https://www.hivenet.com/post/llm-inference-metrics-ttft-tps)
- [TTFT vs throughput — tianpan](https://tianpan.co/blog/2026-03-10-llm-latency-decomposition-ttft-vs-throughput)
- [Load-testing concurrency — spheron](https://www.spheron.network/blog/load-testing-your-llm-endpoint-finding-your-real-concurrency/)
- [Benchmark before capacity — freestyle](https://www.freestyle.sh/blog/engineering/how-to-benchmark-llm-inference)
- [Automatic prefix caching — vLLM](https://docs.vllm.ai/en/v0.8.1/design/automatic_prefix_caching.html)
- [Prefix caching — spheron](https://www.spheron.network/blog/prefix-caching-explained-why-repeated-prompts-get-cheaper-to/)
- [VRAM / KV-cache math — digitalapplied](https://www.digitalapplied.com/blog/how-much-vram-run-llm-quantization-kv-cache-context-2026)
- [LLM VRAM requirements — spheron](https://www.spheron.network/blog/gpu-memory-requirements-llm/)
