# Архитектурные диаграммы

## Компонентная архитектура

Пять слоёв сверху вниз: Linux Services запускают процессы; процессы (точки входа)
создают контекст и вызывают скиллы; **скилл** — центральная абстракция системы
(`SkillContext` → `SkillStatus`); компоненты ядра — универсальная инфраструктура,
которую используют скиллы и точки входа; внешние сервисы.
`scheduler-control` управляет таймером агента через systemctl — стрелка идёт
от L4 к L1 (обратная связь управления).

```mermaid
%%{init: {"flowchart": {"defaultRenderer": "elk"}} }%%
flowchart TB
    subgraph L1["Linux Services"]
        direction LR
        SVC_AG["tg-agent@.timer · .service\noneshot · каждые 10 мин"]
        SVC_OC["openclaw.service\nдолгоживущий"]
        SVC_PER["tg-daily-summary\ntg-funnel-tracker\ntg-channel-activity-update"]
    end

    subgraph L2["Точки входа"]
        direction LR
        Disp["Dispatcher"]
        OC["OpenClaw Plugin"]
        PS["Периодические скрипты"]
    end

    subgraph L3["Абстрактный скилл"]
        SK["Скилл  ·  SkillContext → SkillStatus"]
    end

    subgraph L4["Компоненты ядра"]
        direction LR
        SC["scheduler-control"]
        TG["TelegramService\nGramJS · MTProto"]
        DB["SQLite layer\nbetter-sqlite3"]
        LLM["LlmClient"]
    end

    subgraph L5["Внешние сервисы"]
        direction LR
        TGApi["Telegram API"]
        LLMApi["LLM API"]
    end

    SVC_AG --> Disp
    SVC_OC --> OC
    SVC_PER --> PS

    Disp -->|"SkillContext"| SK
    SK --> TG
    SK --> DB
    SK --> LLM

    OC --> SC
    OC --> TG
    OC --> DB
    OC --> LLM
    Disp --> TG
    Disp --> DB
    Disp --> LLM
    PS --> TG
    PS --> DB

    SC -.->|"systemctl"| SVC_AG

    TG --> TGApi
    LLM --> LLMApi
```

## Топология N-агентов

Один шаблон юнитов (`tg-agent@.service` / `.timer`) обслуживает N агентов через
инстансы. Агенты выполняются параллельно; задачи одного агента — последовательно
(диспетчер — точка сериализации на агента).

```mermaid
flowchart TB
    Code["Общий код платформы\n~/openclaw-plugins/telegram-user-tool/"]

    subgraph sd["systemd · tg-agents.slice  (CPUQuota=70% · MemoryMax=2G)"]
        T1["timer@agent1\nкаждые 10 мин ±2"]
        T2["timer@agent2\nкаждые 10 мин ±2"]
        TN["timer@agentN  (…)"]
        D1["dispatcher --agent agent1\noneshot"]
        D2["dispatcher --agent agent2\noneshot"]
        DN["dispatcher --agent agentN\noneshot"]
        T1 --> D1
        T2 --> D2
        TN --> DN
    end

    W1["workspace-agent1/"]
    W2["workspace-agent2/"]
    WN["workspace-agentN/"]

    D1 <--> W1
    D2 <--> W2
    DN <--> WN

    D1 & D2 & DN --> Code
```

## Lifecycle прогона диспетчера

Ключевые инварианты: холостой прогон не трогает Telegram и LLM; `nextRun`
сдвигается всегда — и при успехе, и при ошибке скилла; сбой записи прогона или
отправки отчёта не валит прогон.

```mermaid
sequenceDiagram
    participant SD as systemd
    participant D as Dispatcher
    participant DB as SQLite
    participant S as Скилл
    participant TG as TelegramService

    SD->>D: старт (--agent agentId)
    D->>DB: ensureSchema · loadAccount
    D->>DB: getDueTasks()

    alt нет назревших задач
        D-->>SD: выход (Telegram и LLM не трогаются)
    else есть задачи
        loop для каждой задачи
            D->>TG: connect (ленивый — при первом обращении)
            D->>S: skill(SkillContext)
            Note right of S: чёрный ящик
            S-->>D: SkillStatus {status, terminal?, details}
            D->>DB: insertRun · advanceTask (всегда, включая ошибку)
            opt terminal = true
                D->>DB: disableTask (enabled = 0)
            end
            D->>TG: sendSavedMessage(отчёт)
        end
        D->>TG: disconnect
        D-->>SD: выход
    end
```

## Наблюдаемость системы

Три канала: структурированные логи → journald; per-run отчёт → Saved Messages
агента; ежедневная агрегация → Saved Messages admin-агента.

```mermaid
flowchart LR
    D["Dispatcher\n(каждый агент)"]
    DS["daily-summary.service\n19:00 UTC"]
    FT["funnel-tracker.service\n19:10 UTC"]

    D -->|"stdout/stderr"| J["journald\njournalctl -u tg-agent@id"]
    D -->|"отчёт после каждой задачи"| SMA["Saved Messages\nагента"]
    DS -->|"сводка по всем агентам"| SMAdmin["Saved Messages\nадмин-агента"]
    FT -->|"метрики воронки"| SMAdmin
```

## Ролевое разделение агентов

В платформе один агент назначается **admin-агентом** (`agent1`). Он является
обычным агентом плюс получает платформенные отчёты и владеет платформенными БД.

| Возможность | Обычный агент | Admin-агент (agent1) |
|:---|:---:|:---:|
| Задачи и скиллы по расписанию | + | + |
| Изолированные БД агента | + | + |
| Per-run отчёт в собственные Saved Messages | + | + |
| Дневная сводка прогонов всех агентов | — | + |
| Воронка платформы | — | + |
| `funnel.db` (агрегат метрик) | — | + |
| `discovery.db` (реестр каналов) | — | + |

