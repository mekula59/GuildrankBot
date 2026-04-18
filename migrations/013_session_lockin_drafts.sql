begin;

create table if not exists session_lockin_drafts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  session_candidate_id uuid not null references session_candidates(id) on delete cascade,
  scheduled_session_id uuid references scheduled_sessions(id) on delete set null,
  selection_source text not null default 'admin_selected',
  notes text,
  locked_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_candidate_id),
  constraint session_lockin_drafts_selection_source_check check (
    selection_source in ('admin_selected', 'threshold_default')
  )
);

create index if not exists idx_session_lockin_drafts_guild_candidate
  on session_lockin_drafts(guild_id, session_candidate_id);

create index if not exists idx_session_lockin_drafts_guild_schedule
  on session_lockin_drafts(guild_id, scheduled_session_id)
  where scheduled_session_id is not null;

create table if not exists session_lockin_draft_players (
  id uuid primary key default gen_random_uuid(),
  session_lockin_draft_id uuid not null references session_lockin_drafts(id) on delete cascade,
  guild_id text not null,
  discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_lockin_draft_id, discord_user_id)
);

create index if not exists idx_session_lockin_draft_players_guild_user
  on session_lockin_draft_players(guild_id, discord_user_id, created_at desc);

alter table session_lockin_drafts enable row level security;
alter table session_lockin_draft_players enable row level security;

insert into schema_migrations (version, name)
values ('013_session_lockin_drafts', 'Admin lock-in draft layer for VC-assisted candidates')
on conflict (version) do nothing;

commit;
