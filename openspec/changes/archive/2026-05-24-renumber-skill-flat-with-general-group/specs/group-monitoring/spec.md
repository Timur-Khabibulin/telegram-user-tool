## ADDED Requirements

### Requirement: SKILL document uses flat step numbering with one parent for generalMessages handling

Файл `skills/telegram-group-monitor/SKILL.md` SHALL использовать плоскую сквозную нумерацию шагов уровня `5.x`: классификация (`tg_classify_messages`), обработка `newThreadMessages`, обработка `threadReplies` — каждая как самостоятельный шаг без точечного префикса вида `5.2.6`. Шаги, относящиеся к обработке `generalMessages` (определение тем, отбор релевантных, генерация ответов, отправка), SHALL быть сгруппированы под одним родительским шагом `5.6 Обработать generalMessages` с подшагами `5.6.1–5.6.4`.

Целевая структура:

```
5.1   Получить непрочитанные сообщения        (telegram_get_messages)
5.2   Пометить как прочитанные                (telegram_mark_as_read)
5.3   Классифицировать сообщения              (tg_classify_messages)
5.4   Обработать newThreadMessages
5.5   Обработать threadReplies
5.6   Обработать generalMessages
      5.6.1 Определить темы обсуждения        (LLM)
      5.6.2 Отобрать релевантные сообщения    (LLM)
      5.6.3 Сгенерировать ответы              (LLM)
      5.6.4 Отправить ответы                  (telegram_reply_to_message)
5.7   Сохранить прогресс                      (tg_channels_mark_processed)
5.8   Оценить сообщения для DM-кандидатов     (dm_candidates_insert)
```

Поведенческие требования (какие инструменты вызываются, в каком порядке, с какими параметрами) NOT changed — структурное изменение касается только нумерации и группировки в SKILL-документе.

#### Scenario: Steps for classification and thread handling are flat

- **WHEN** агент читает `SKILL.md`
- **THEN** шаги классификации и обработки тредов имеют номера `5.3`, `5.4`, `5.5` соответственно, без точечной вложенности типа `5.2.x`

#### Scenario: GeneralMessages handling has one parent step with substeps

- **WHEN** агент достигает обработки `generalMessages`
- **THEN** в `SKILL.md` это один родительский шаг `5.6` с подшагами `5.6.1` (определить темы), `5.6.2` (отобрать), `5.6.3` (сгенерировать), `5.6.4` (отправить)

#### Scenario: Intro range matches actual step set

- **WHEN** агент читает вводную строку перед перечислением шагов 5.x
- **THEN** диапазон шагов в intro соответствует реальному перечню (включая 5.8)

#### Scenario: Forward references point to current numbering

- **WHEN** в тексте шага встречается ссылка на номер другого шага (например, «из результата шага N»)
- **THEN** N соответствует текущей нумерации (`5.3` для классификации, `5.6.2/5.6.3` для отбора/генерации внутри родителя 5.6, и т. д.) — никаких упоминаний устаревших `5.2.6/5.2.7/5.2.8`

#### Scenario: Tools table uses new step numbers

- **WHEN** агент смотрит таблицу «Инструменты» в конце `SKILL.md`
- **THEN** колонка «Шаг» для `tg_classify_messages` содержит `5.3`, для `tg_group_thread_create` — `5.4`, для `tg_group_thread_update` — `5.4, 5.5`, для `telegram_reply_to_message` — `5.4, 5.5, 5.6.4`

#### Scenario: Behavior is unchanged

- **WHEN** агент проходит ренумерованный SKILL шаг за шагом
- **THEN** последовательность вызовов инструментов, параметры и LLM-промпты остаются такими же, как до изменения — меняется только то, как пронумерованы шаги в документе