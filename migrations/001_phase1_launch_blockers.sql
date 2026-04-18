begin;

create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz default now(),
  name       text not null
);

alter table events add column if not exists request_id text;
create unique index if not exists idx_events_request_id on events(request_id);

alter table vc_sessions add column if not exists raw_duration_minutes integer;
alter table vc_sessions add column if not exists credited_minutes integer;
alter table vc_sessions add column if not exists had_companion boolean default false;
alter table vc_sessions add column if not exists anti_farming_reason text;

update vc_sessions
set
  raw_duration_minutes = coalesce(raw_duration_minutes, duration_minutes),
  credited_minutes = coalesce(credited_minutes, duration_minutes)
where raw_duration_minutes is null
   or credited_minutes is null;

create table if not exists audit_logs (
  id               uuid primary key default gen_random_uuid(),
  guild_id         text not null,
  actor_discord_id text,
  action_type      text not null,
  target_type      text not null,
  target_id        text,
  request_id       text,
  reason           text,
  before_json      jsonb,
  after_json       jsonb,
  metadata         jsonb default '{}'::jsonb,
  created_at       timestamptz default now()
);

create index if not exists idx_audit_logs_guild_created on audit_logs(guild_id, created_at desc);
create index if not exists idx_audit_logs_actor_created on audit_logs(actor_discord_id, created_at desc);
create unique index if not exists idx_audit_logs_action_request on audit_logs(action_type, request_id) where request_id is not null;

create table if not exists admin_corrections (
  id               uuid primary key default gen_random_uuid(),
  guild_id         text not null,
  actor_discord_id text not null,
  correction_type  text not null,
  target_type      text not null,
  target_id        text,
  request_id       text,
  reason           text not null,
  before_json      jsonb,
  after_json       jsonb,
  metadata         jsonb default '{}'::jsonb,
  created_at       timestamptz default now()
);

create index if not exists idx_admin_corrections_guild_created on admin_corrections(guild_id, created_at desc);
create unique index if not exists idx_admin_corrections_request on admin_corrections(request_id) where request_id is not null;

create table if not exists job_runs (
  job_type         text not null,
  scope_key        text not null,
  owner_id         text not null,
  status           text not null default 'running',
  started_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  finished_at      timestamptz,
  lease_expires_at timestamptz not null,
  error_message    text,
  metadata         jsonb default '{}'::jsonb,
  primary key (job_type, scope_key)
);

create table if not exists weekly_digest_history (
  id            uuid primary key default gen_random_uuid(),
  guild_id      text not null,
  digest_key    text not null,
  channel_id    text,
  job_scope_key text,
  status        text not null default 'started',
  message_id    text,
  sent_at       timestamptz,
  error_message text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (guild_id, digest_key)
);

create index if not exists idx_weekly_digest_history_status on weekly_digest_history(status, created_at desc);

insert into schema_migrations (version, name)
values ('001_phase1_launch_blockers', 'Phase 1 launch blockers')
on conflict (version) do nothing;

commit;
