## ADDED Requirements

### Requirement: Гейт по среднему охвату публикации опционален

Если параметр `minAvgPostReach` не задан при запуске discovery, гейт по охвату SHALL NOT применяться и поведение SHALL совпадать с v1 (отбор только по подписчикам).

#### Scenario: Гейт не задан — поведение v1

- **WHEN** `minAvgPostReach` не передан в параметрах прогона
- **THEN** `channels/stat` не вызывается ни для одного кандидата и все кандидаты, прошедшие гейт подписчиков, идут в `registerChannel`

### Requirement: Гейт по охвату применяется после дедупа и гейта подписчиков

Если `minAvgPostReach` задан, система SHALL для каждого кандидата, прошедшего `isKnownChannel` и `participantsCount >= minSubscribers`, запрашивать TGStat `channels/stat` по `tgId` кандидата и проверять `avg_post_reach >= minAvgPostReach`.

#### Scenario: Кандидат проходит гейт охвата

- **WHEN** `minAvgPostReach` задан и TGStat вернул `avg_post_reach` строго больше `minAvgPostReach`
- **THEN** кандидат переходит к `registerChannel`

#### Scenario: Кандидат не проходит гейт охвата

- **WHEN** `minAvgPostReach` задан и TGStat вернул `avg_post_reach <= minAvgPostReach`
- **THEN** кандидат отсеивается, счётчик `rejectedByAvgReach` увеличивается на 1, цикл переходит к следующему кандидату

#### Scenario: `channels/stat` недоступен — MTProto fallback

- **WHEN** `minAvgPostReach` задан и вызов `channels/stat` завершился ошибкой (HTTP != 2xx или `status != "ok"`)
- **THEN** система SHALL перейти к MTProto fallback (см. Requirement ниже)

#### Scenario: `tgId` отсутствует — MTProto fallback

- **WHEN** `minAvgPostReach` задан и у кандидата `tgId == null`
- **THEN** `channels/stat` не вызывается, система SHALL перейти к MTProto fallback по username из `c.link`

### Requirement: MTProto fallback при недоступности данных TGStat

Если TGStat не дал данные об охвате, система SHALL вычислить средний охват вручную: получить последние 10 постов канала через Telegram и взять среднее значение просмотров. Для этого SHALL быть задан `avgReachAgentId`.

#### Scenario: MTProto fallback успешен — кандидат проходит гейт

- **WHEN** TGStat не дал данные, `avgReachAgentId` задан, вычисленный охват строго больше `minAvgPostReach`
- **THEN** кандидат переходит к `registerChannel`

#### Scenario: MTProto fallback успешен — кандидат не проходит гейт

- **WHEN** TGStat не дал данные, `avgReachAgentId` задан, вычисленный охват `<= minAvgPostReach`
- **THEN** кандидат отсеивается, счётчик `rejectedByAvgReach` увеличивается на 1

#### Scenario: `avgReachAgentId` не задан — fail-closed

- **WHEN** TGStat не дал данные и `avgReachAgentId` не задан
- **THEN** кандидат отсеивается (fail-closed), счётчик `rejectedByAvgReach` увеличивается на 1

#### Scenario: MTProto fallback завершился ошибкой — fail-closed

- **WHEN** TGStat не дал данные, `avgReachAgentId` задан, но получение постов через Telegram завершилось ошибкой
- **THEN** кандидат отсеивается (fail-closed), счётчик `rejectedByAvgReach` увеличивается на 1

#### Scenario: Приватная ссылка — fall-closed

- **WHEN** TGStat не дал данные и `c.link` является invite-ссылкой вида `t.me/+…` (нет username)
- **THEN** кандидат отсеивается (fail-closed), счётчик `rejectedByAvgReach` увеличивается на 1

### Requirement: Аккаунт для MTProto fallback задаётся оператором

`avgReachAgentId` SHALL быть необязательным параметром прогона. Без него MTProto fallback не производится.

#### Scenario: avgReachAgentId не задан — TGStat единственный источник

- **WHEN** `avgReachAgentId` не передан в параметрах прогона
- **THEN** при ошибке `channels/stat` система сразу применяет fail-closed (без попытки MTProto)

### Requirement: Счётчик отсева по охвату присутствует в результате

`RunResult` SHALL содержать поле `rejectedByAvgReach: number`. Если гейт не активен — значение равно 0.

#### Scenario: Гейт активен и отсеял кандидатов

- **WHEN** `minAvgPostReach` задан и несколько кандидатов не прошли гейт (по любой из причин: низкий охват, ошибка API, нет `tgId`, нет `avgReachAgentId`, ошибка MTProto)
- **THEN** `result.rejectedByAvgReach` равно суммарному числу отсеянных по гейту охвата

#### Scenario: Гейт не задан — счётчик нулевой

- **WHEN** `minAvgPostReach` не задан
- **THEN** `result.rejectedByAvgReach` равно 0

### Requirement: Отчёт оператору содержит строку об отсеве по охвату

Если `minAvgPostReach` был задан, `renderReport` SHALL включать строку с числом кандидатов, отсеянных по гейту охвата.

#### Scenario: Строка отсева показывается при активном гейте

- **WHEN** `minAvgPostReach` задан (в том числе если `rejectedByAvgReach = 0`)
- **THEN** отчёт содержит строку вида `• отсеяно по охвату: <N>`

#### Scenario: Строка отсева не показывается при неактивном гейте

- **WHEN** `minAvgPostReach` не задан
- **THEN** отчёт не содержит строки об охвате
