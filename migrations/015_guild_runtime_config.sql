begin;

alter table guild_configs add column if not exists timezone text;
alter table guild_configs add column if not exists digest_time_utc text;
alter table guild_configs add column if not exists badge_channel_id text;
alter table guild_configs add column if not exists digest_channel_id text;
alter table guild_configs add column if not exists operator_role_ids text[];
alter table guild_configs add column if not exists game_catalog_enabled boolean;

do $$
begin
  alter table guild_configs
    add constraint guild_configs_digest_time_utc_format_check
    check (
      digest_time_utc is null
      or digest_time_utc ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    );
exception
  when duplicate_object then null;
end $$;

insert into schema_migrations (version, name)
values ('015_guild_runtime_config', 'Per-guild runtime config extension')
on conflict (version) do nothing;

commit;
