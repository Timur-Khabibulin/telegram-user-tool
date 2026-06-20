# 0003. peerCache из get_dialogs, без getEntity

- Статус: принято
- Дата: 2026-04-28

## Контекст
Для `mark_as_read` и `reply` нужен валидный `InputPeer` с правильным `access_hash`.
Восстановление пира через `client.getEntity(BigInt(id))` опирается на in-memory
кэш GramJS, который не переживает перезапуск процесса и возвращает невалидный
`access_hash` → `PEER_ID_INVALID`.

## Решение
Заполнять `peerCache` из `get_dialogs` (там всегда полный `access_hash` из
`d.entity`) и переиспользовать его в `mark_as_read`/`reply`. На каждом прогоне
сначала вызывается `get_dialogs`. `InputPeer` конструируется явно
(`InputPeerChannel`/`InputPeerChat`).

## Последствия
- Устранён класс ошибок `PEER_ID_INVALID` для чатов из `get_dialogs`.
- Минус: кэш не переживает перезапуск → `get_dialogs` обязателен в начале прогона.
- Открытый край: `get_dialogs` возвращает только непрочитанные — старые/неактивные
  чаты могут не попасть в кэш (см. backlog «Стабильность peerCache»).

## Отвергнутые варианты
- `getEntity(BigInt(id))` для восстановления пиров: даёт невалидный `access_hash`.
