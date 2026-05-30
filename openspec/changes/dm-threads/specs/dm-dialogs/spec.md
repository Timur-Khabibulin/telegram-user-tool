## ADDED Requirements

### Requirement: telegram_get_dm_dialogs returns DM chats with unread messages
Инструмент `telegram_get_dm_dialogs()` SHALL запрашивать у Telegram список личных чатов (тип `User`) с `unreadCount > 0` и возвращать массив объектов с полями: `userId`, `accessHash`, `userName`, `firstName`, `unreadCount`, `readInboxMaxId`. Также SHALL заполнять `peerCache` записью `InputPeerUser` для каждого возвращённого пользователя.

#### Scenario: DM chats with unread messages found
- **WHEN** у аккаунта есть 3 личных чата с непрочитанными сообщениями
- **THEN** возвращается `{ dms: [{userId, accessHash, userName, firstName, unreadCount, readInboxMaxId}, ...] }` с 3 элементами, `peerCache` содержит 3 записи `InputPeerUser`

#### Scenario: No unread DM chats
- **WHEN** у аккаунта нет личных чатов с непрочитанными сообщениями
- **THEN** возвращается `{ dms: [] }`

#### Scenario: peerCache populated for subsequent operations
- **WHEN** `telegram_get_dm_dialogs` вернул пользователя с `userId: "123"` и `accessHash: "abc"`
- **THEN** `peerCache` содержит запись для userId `"123"` как `InputPeerUser({userId: 123, accessHash: abc})`, доступную для `telegram_send_dm`, `telegram_get_messages`, `telegram_mark_as_read`
