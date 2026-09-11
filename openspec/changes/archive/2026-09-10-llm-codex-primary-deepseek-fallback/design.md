## Context

LLM-слой собран в одной функции `createLlmClient()` (`src/llm/client.ts`); все входы
зовут её без аргументов через контракт `LlmClient`. Сейчас (после
`migrate-llm-to-deepseek`) там один провайдер DeepSeek напрямую, без фолбэка.

Спайком подтверждено, что доступ к ChatGPT-подписке снова возможен in-process через
`@openai-oauth/ai-sdk` (v2, июль 2026, spec `v3`, ai@6): `createOpenAIOAuth`
корректно шлёт codex-`originator`, модель `gpt-5.6-sol` отвечает, `generateObject`
даёт валидный JSON. Токен — живой `~/.openclaw/codex-auth/auth.json`, рефреш делает
библиотека.

Цель — вернуть дешёвый флэт как primary, но не повторить сентябрьскую аварию (когда
codex отвалился и LLM встал целиком): DeepSeek остаётся как fallback.

## Goals / Non-Goals

**Goals:**
- Primary — codex-подписка (`gpt-5.6-sol`) через `@openai-oauth/ai-sdk`.
- Fallback — DeepSeek (`deepseek-flash`) на любую ошибку primary через `ai-fallback`.
- Срабатывание фолбэка видимо в логах.
- Контракт `LlmClient` и вызывающий код не меняются.

**Non-Goals:**
- Тонкая настройка предиката фолбэка (переключаемся на любую ошибку — решение принято).
- Строка «фолбэков за день» в дневной сводке (достаточно лога — решение принято).
- Off-peak DeepSeek.
- Мультиаккаунтность codex / пул токенов.

## Decisions

### Библиотека `@openai-oauth/ai-sdk` (не форк, не прокси, не CLI)

Спайк подтвердил: живая (июль 2026), spec `v3` (ai@6), drop-in интерфейс
`createOpenAIOAuth(...)` как у прежнего провайдера, авто-рефреш, шлёт корректный
originator (проходит гейтинг). Поддержку originator/version под релизы Codex несёт
мейнтейнер пакета, а не мы (в отличие от форка `openai-oauth-provider`, мёртвого с
марта).
**Альтернативы (отклонены):** форк `openai-oauth-provider` (наш вечный долг по
fingerprint); прокси-сервис (проектирование + межсервисное взаимодействие); CLI-спавн
(агентный рантайм на вызов).

### Модель `gpt-5.6-sol`

Лёгкая (аналог прежней `gpt-5.4-mini`, которая ретайрнута). Спайком отвечает и держит
structured output. `gpt-5.6-terra`/`gpt-5.5` тоже доступны, но нужна лёгкая.

### Fallback через `ai-fallback` на любую ошибку

`createFallback({ models: [codex(sol), deepseek(flash)] })` — тот же механизм, что был
в исходной codex-схеме, теперь с двумя реальными моделями. Переключение на **любую**
ошибку primary (решение пользователя) — проще предиката и безопасно, т.к. DeepSeek —
надёжный дублёр. Невалидный JSON фолбэк НЕ трогает: это обрабатывают три слоя
`completeObject` над моделью, а не ошибка провайдера.

### Видимость фолбэка — лог

`onError`/колбэк `ai-fallback` пишет причину (ошибку primary) в logger → journald.
Без этого отказ codex и переход на платный DeepSeek были бы тихими (уже наступали на
это с `runs-summary`). Строку в дневную сводку не добавляем (решение пользователя).

### Персона в codex

`system` уходит в модель как раньше; доставку в codex (`instructions`) обеспечивает
`@openai-oauth/ai-sdk`. Точный маппof `system`→codex подтверждается спайком до
раскатки (см. tasks).

## Risks / Trade-offs

- **Тихий отказ codex + расход DeepSeek** → лог срабатывания фолбэка (Decision выше).
- **ToS/бан ChatGPT-аккаунта** (primary — имперсонация официального клиента через
  библиотеку) → фолбэк держит сервис живым, но флэт-тир при бане теряется.
- **Две модели — разный тон/русский** (`gpt-5.6-sol` vs `deepseek-flash`) → приемлемо,
  основной трафик на sol; fallback лишь при сбоях.
- **Зависимость от живости `@openai-oauth/ai-sdk`** → если пакет забросят и codex
  сменит гейт, primary сломается и мы деградируем на DeepSeek (graceful, сервис стоит).
- **Персона→codex маппинг** отличается от DeepSeek → спайк до раскатки.

## Migration Plan

1. Зависимости: `+ @openai-oauth/ai-sdk`, `+ @openai-oauth/local`, `+ ai-fallback`;
   `@ai-sdk/deepseek` оставить.
2. `createLlmClient()`: primary `createOpenAIOAuth(openaiCredentials({ authFilePath: codex-auth/auth.json }))("gpt-5.6-sol")`,
   fallback `createDeepSeek({apiKey})("deepseek-flash")`, обернуть в `createFallback`
   с логированием `onError`.
3. Спайк персоны: подтвердить, что `system` доезжает в codex как инструкция.
4. Деплой: scp `client.ts`+`package.json`, `npm install` на VPS, рестарт gateway;
   `~/.openclaw/codex-auth/` на месте, `DEEPSEEK_API_KEY` в secrets.env.
5. Проверка: успешные LLM-прогоны идут на codex; принудительная ошибка primary
   (например, временно испорченный токен) → в логах виден фолбэк, вызов проходит на
   DeepSeek.

**Rollback:** вернуть `createLlmClient()` к DeepSeek-only (состояние после
`migrate-llm-to-deepseek`) — DeepSeek проверен и работает.

## Open Questions

- **Порядок архивации:** дельта спеки написана относительно состояния «DeepSeek —
  primary», т.е. `migrate-llm-to-deepseek` нужно архивировать до архивации этого
  change (иначе заголовки REMOVED-требований не совпадут с базой).
- Точный вид колбэка логирования зависит от API установленной версии `ai-fallback`
  (`onError` vs иной хук) — уточнить при реализации.
