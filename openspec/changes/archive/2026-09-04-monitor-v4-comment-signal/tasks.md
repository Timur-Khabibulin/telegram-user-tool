## 1. Комментарии поста (TelegramService)

- [x] 1.1 Добавить в `core/telegram/service.ts` метод получения комментариев
      поста канала (`getPostComments`) через GramJS `client.getMessages(peer,
      { replyTo: msgId })` — официальная обёртка над `messages.GetReplies`
      («known as comments in posts of broadcast channels»). Возвращает
      `total` (общее число, `TotalList.total`) и `comments: TgMessage[]`.
- [x] 1.2 Пагинация до исчерпания — оказалась не нужна руками: `limit` не
      передаётся, GramJS сам догружает страницы, пока не заберёт все
      сообщения («if undefined is passed... library will try to retrieve all
      the messages», тот же механизм, что уже используется в `getMessages`
      для истории >100 сообщений). Верхнего предела нет (design.md, Decision 2).
- [x] 1.3 Резолв `fromName`/`fromId` авторов — тот же маппинг, что в
      `getMessages` (`m.sender`, уже резолвлен GramJS из users/chats ответа).
- [x] 1.4 FLOOD_WAIT → `FloodWaitError`, тот же паттерн (`parseFloodWait` +
      `invokeChecked`), что у `getDiscussionMessage`/остальных методов.

## 2. Промпт и схема

- [x] 2.1 Добавить `generatePostCommentV4(postText, commentsText)` в
      `src/llm/prompts.ts` рядом с `generatePostCommentV3` (не изменяется) —
      текст промпта согласован с пользователем в рамках explore-сессии,
      перенесён дословно.
- [x] 2.2 Сериализация комментариев в `commentsText` — по аналогии с
      `generateThreadContinuation`/`analyzeChannelMessages`
      (`- {имя}: {текст}` построчно) — реализуется в monitor-v4.ts (3.3).
- [x] 2.3 Схема ответа (инлайн в `monitor-v4.ts`, как и текущая
      `generatePostCommentV3`-схема):
      ```ts
      z.object({
          оценка: z.number().min(0).max(4),
          решение: z.enum(["пропустить", "комментировать"]),
          главное_мнение: z.string().nullable(),
          комментарий: z.string().nullable(),
      })
      ```

## 3. Скилл monitor-v4 — §2b.iv-v

- [x] 3.1 Заменить `passesPrefilter(latestPost.text)` на гейт по числу
      комментариев (`getPostComments`, `.total < MIN_COMMENTS_TO_CONSIDER`
      (=3) → отсев, design.md Decision 1). `passesPrefilter`/`PREFILTER_MIN_LEN`
      удалены из `monitor-v4.ts` как мёртвый код (гейт заменён, не дополнен).
- [x] 3.2 Отсев по числу комментариев → тот же путь, что раньше у
      `passesPrefilter`-отказа: `markPostSeen` + `resolveDay` (кэш дня,
      change `monitor-v4`) + `markChannelProcessed`.
- [x] 3.3 При `total ≥ 3` — собрать все комментарии (уже в ответе
      `getPostComments`, без отдельного вызова), сериализовать
      (`- {имя}: {текст}`), вызвать `llm.completeObject` с
      `generatePostCommentV4` и схемой (2.1/2.3).
- [x] 3.4 Ветвление по `решение`: `"пропустить"` (или пустой `комментарий`)
      → тот же путь, что 3.2; `"комментировать"` → поиск `rootMsgId` через
      `getDiscussionMessage` (оставлено как в monitor-v3/исходном monitor-v4
      — простой и надёжный путь; вариант «вывести из replyToTopId уже
      полученного комментария» не даёт экономии вызова, раз `getDiscussionMessage`
      всё равно остаётся единственным надёжным способом узнать rootMsgId при
      отсутствии комментариев с этим полем) → отправка → `applyApprovedComment`
      → `resolveDay(latestPost.id)`.
- [x] 3.5 `channel.channelId`/`channelAccessHash` — проверка перенесена перед
      гейтом по комментариям (нужны уже для `getPostComments`, не только для
      `getDiscussionMessage`), раньше, чем в исходном `monitor-v4`/`monitor-v3`.

## 4. Проверка

- [x] 4.1 `npx tsc --noEmit` — типы проходят без ошибок в новых/изменённых
      файлах (`--module esnext` для обхода предсуществующей несвязанной
      ошибки конфигурации tsconfig, см. change `monitor-v4`).
