# Memory Index

- [Funnel v2 storage decision](project_funnel_v2_storage.md) — Q3/Q4 закрыты новыми таблицами `channel_visits`/`send_errors` в `tg-channels.db`, не в `funnel.db`
- [Post-freshness-gate architecture](project_post_freshness_gate.md) — additive v2 skill via tasks-table toggle; lastProcessedAt is variant-unaware (hazard, coordinator declined a code guard)
- [Don't override requirements from code inference](feedback_dont_override_requirements_from_code_inference.md) — check bussines-system-analytic memory before dropping a requirements-literal case as "just an optimization"
- [No document edit-history narrative](feedback_no_document_edit_history_narrative.md) — architecture/requirements docs state final decisions only, never "previous draft wrongly did X"
- [Funnel v3 architecture](project_funnel_v3_architecture.md) — private-invite-links already built in code; channelUsername≠chatUsername; groupReplies has a hidden funnel-stats consumer
- [Check hidden schema consumers before renaming](feedback_check_hidden_schema_consumers_before_renaming.md) — grep whole repo incl. .claude/skills/ before repurposing a persisted DB field's meaning
- [tg-agent-autoregistration: tdata decryption risk](project_tg_agent_autoregistration_tdata_risk.md) — Variant A risk is 3-layer undocumented KDF/AES-IGE format in key_datas→maps, not StringSession assembly
- [tg-agent-autoregistration: Variant A2 @mtcute/convert](project_tg_agent_autoregistration_variant_a2_mtcute_convert.md) — convertFromTdata+convertToGramjsSession byte-match GramJS StringSession; hidden @mtcute/node runtime dep; version risk confirmed by maintainer's own comments
- [tg-agent-autoregistration: setup MTProto calls](project_tg_agent_autoregistration_setup_mtproto_calls.md) — exact API map: client.updateTwoFaSettings (SRP built-in), auth.resetAuthorizations (24h limit), account.updatePersonalChannel (confirmed real, needs broadcast channel)
- [tg-agent-autoregistration: cleanup calls](project_tg_agent_autoregistration_cleanup_calls.md) — photos.getUserPhotos/deletePhotos, channels.getAdminedPublicChannels; real conflict is CHANNELS_ADMIN_PUBLIC_TOO_MUCH on updateUsername, not on updatePersonalChannel itself
