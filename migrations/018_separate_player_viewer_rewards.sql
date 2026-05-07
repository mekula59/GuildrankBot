begin;

alter table guild_configs
  add column if not exists player_reward_role_id text,
  add column if not exists spectator_reward_role_id text;

alter table guild_configs
  drop constraint if exists guild_configs_participant_reward_scope_check;

alter table guild_configs
  add constraint guild_configs_participant_reward_scope_check
  check (participant_reward_scope in (
    'players_only',
    'spectators_only',
    'players_and_spectators',
    'separate_roles'
  ));

insert into schema_migrations (version, description)
values ('018_separate_player_viewer_rewards', 'Separate player and spectator reward roles')
on conflict (version) do nothing;

commit;
