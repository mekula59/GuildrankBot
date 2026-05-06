begin;

alter table guild_configs
  add column if not exists participant_reward_role_id text,
  add column if not exists participant_reward_enabled boolean not null default false,
  add column if not exists participant_reward_scope text not null default 'players_only';

do $$
begin
  alter table guild_configs
    add constraint guild_configs_participant_reward_scope_check
    check (participant_reward_scope in ('players_only', 'players_and_spectators'));
exception
  when duplicate_object then null;
end $$;

insert into schema_migrations (version, name)
values ('017_participant_reward_roles', 'Per-guild participant reward role config')
on conflict (version) do nothing;

commit;
