begin;

create unique index if not exists idx_session_candidates_single_open_per_channel
on session_candidates(guild_id, channel_id)
where status = 'open';

insert into schema_migrations (version, name)
values ('007_vc_assisted_candidate_guardrails', 'VC-assisted candidate lifecycle guardrails')
on conflict (version) do nothing;

commit;
