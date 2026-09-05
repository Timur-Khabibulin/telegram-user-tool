## ADDED Requirements

### Requirement: Channel status supports comment-watch and sleep states
Поле `channels.status` SHALL поддерживать два дополнительных значения,
наравне с уже существующими `banned`/`suspend`/`format_error`: `only_comment`
и `sleep`. Канал SHALL находиться только в одном значении `status`
одновременно. Таблица `channels` SHALL иметь дополнительные поля
`lastSeenChannelPostId` (id последнего поста канала, на который агент
отреагировал) и `watchedThreadRootMsgId` (id служебной копии этого поста в
чате обсуждения) — оба nullable, заполняются только при успешной отправке
комментария к посту (`channel-post-watch`).

#### Scenario: Новое значение статуса не конфликтует с существующими
- **WHEN** канал получает `status = only_comment` или `status = sleep`
- **THEN** предыдущее значение `status` (если было) заменяется, `channels`
  хранит ровно одно текущее значение статуса для канала
