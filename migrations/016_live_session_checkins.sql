begin;

alter table live_sessions
  add column if not exists checkin_status text not null default 'closed',
  add column if not exists checkin_opened_at timestamptz,
  add column if not exists checkin_closed_at timestamptz;

do $$
begin
  alter table live_sessions
    add constraint live_sessions_checkin_status_check
    check (checkin_status in ('open', 'closed'));
exception
  when duplicate_object then null;
end $$;

create table if not exists live_session_confirmations (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  live_session_id uuid not null references live_sessions(id) on delete cascade,
  discord_user_id text not null,
  response text not null,
  source text not null default 'button',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (live_session_id, discord_user_id),
  constraint live_session_confirmations_response_check check (response in ('playing', 'spectating', 'not_in_session')),
  constraint live_session_confirmations_source_check check (source in ('button', 'operator'))
);

create index if not exists idx_live_session_confirmations_guild_session_response
  on live_session_confirmations(guild_id, live_session_id, response);

create index if not exists idx_live_session_confirmations_guild_user_updated
  on live_session_confirmations(guild_id, discord_user_id, updated_at desc);

alter table live_session_confirmations enable row level security;

insert into schema_migrations (version, name)
values ('016_live_session_checkins', 'Live session participant self check-in draft layer')
on conflict (version) do nothing;

commit;
