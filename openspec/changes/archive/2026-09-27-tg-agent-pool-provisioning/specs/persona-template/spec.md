## MODIFIED Requirements

### Requirement: Остальные файлы шаблона копируются один раз при регистрации
Файлы шаблона персоны, не являющиеся текстом промпта (`post.txt`,
`photo_profile_N.*`, `channel_photo.*`, `channel_post_photo.*`,
`profile_data.json`) SHALL продолжать копироваться/применяться в процессе
регистрации агента один раз — как одноразовая настройка TG-профиля аккаунта, не
как источник, читаемый рантаймом повторно. Общие технические значения
(`apiId`/`apiHash`/2FA) SHALL НЕ храниться в шаблоне персоны: они вынесены в общую
заготовку `~/.openclaw/account-defaults/default_agent_data.json` и в шаблоне
персоны файла `default_agent_data.json` больше нет.

#### Scenario: Регистрация нового агента
- **WHEN** создаётся новый агент со ссылкой на персону `maria`
- **THEN** фото профиля, пост и текстовые данные профиля из
  `~/.openclaw/personas/maria/` применяются к аккаунту один раз; `SOUL.md` не
  копируется — только ссылка `persona` сохраняется в `tg-account.json` агента

#### Scenario: Общие creds берутся из заготовки, не из персоны
- **WHEN** процессу подготовки аккаунта нужны `apiId`/`apiHash`/целевой 2FA
- **THEN** они читаются из `~/.openclaw/account-defaults/default_agent_data.json`,
  а не из папки персоны; папка персоны файла `default_agent_data.json` не содержит
