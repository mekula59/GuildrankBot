begin;

create table if not exists tracked_voice_channels (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text not null,
  channel_name_snapshot text not null,
  game_key text not null,
  session_type text not null,
  tracking_enabled boolean not null default true,
  ignore_for_candidates boolean not null default false,
  is_afk_channel boolean not null default false,
  min_active_members integer not null default 2,
  min_candidate_duration_minutes integer not null default 10,
  min_participant_presence_minutes integer not null default 5,
  grace_gap_seconds integer not null default 180,
  auto_close_after_idle_minutes integer not null default 10,
  created_by_discord_user_id text not null default 'system',
  updated_by_discord_user_id text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guild_id, channel_id),
  constraint tracked_voice_channels_min_active_members_check check (min_active_members >= 2),
  constraint tracked_voice_channels_min_candidate_duration_check check (min_candidate_duration_minutes >= 1),
  constraint tracked_voice_channels_min_participant_presence_check check (min_participant_presence_minutes >= 1),
  constraint tracked_voice_channels_grace_gap_check check (grace_gap_seconds >= 0),
  constraint tracked_voice_channels_auto_close_idle_check check (auto_close_after_idle_minutes >= 1)
);

create index if not exists idx_tracked_voice_channels_guild on tracked_voice_channels(guild_id);
create index if not exists idx_tracked_voice_channels_guild_enabled on tracked_voice_channels(guild_id, tracking_enabled);
create index if not exists idx_tracked_voice_channels_guild_game on tracked_voice_channels(guild_id, game_key);

create table if not exists voice_presence_segments (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text not null,
  tracked_voice_channel_id uuid references tracked_voice_channels(id) on delete set null,
  discord_user_id text not null,
  joined_at timestamptz not null,
  left_at timestamptz,
  duration_seconds integer,
  segment_status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint voice_presence_segments_status_check check (segment_status in ('open', 'closed')),
  constraint voice_presence_segments_left_after_joined_check check (left_at is null or left_at >= joined_at),
  constraint voice_presence_segments_duration_non_negative_check check (duration_seconds is null or duration_seconds >= 0)
);

create index if not exists idx_voice_presence_segments_guild_channel_joined on voice_presence_segments(guild_id, channel_id, joined_at);
create index if not exists idx_voice_presence_segments_guild_user_joined on voice_presence_segments(guild_id, discord_user_id, joined_at desc);
create index if not exists idx_voice_presence_segments_tracked_joined on voice_presence_segments(tracked_voice_channel_id, joined_at);
create unique index if not exists idx_voice_presence_segments_single_open on voice_presence_segments(guild_id, discord_user_id) where segment_status = 'open';

create table if not exists session_candidates (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  tracked_voice_channel_id uuid not null references tracked_voice_channels(id) on delete restrict,
  channel_id text not null,
  channel_name_snapshot text not null,
  game_key text not null,
  session_type text not null,
  status text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  last_activity_at timestamptz not null,
  detected_member_count integer not null default 0,
  detection_version text not null default 'v1',
  finalized_official_session_id uuid references events(id) on delete set null,
  discard_reason text,
  discarded_by_discord_user_id text,
  finalized_by_discord_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_candidates_status_check check (status in ('open', 'closed', 'finalized', 'discarded')),
  constraint session_candidates_ended_after_started_check check (ended_at is null or ended_at >= started_at),
  constraint session_candidates_last_activity_after_started_check check (last_activity_at >= started_at)
);

create index if not exists idx_session_candidates_guild_status_started on session_candidates(guild_id, status, started_at desc);
create index if not exists idx_session_candidates_guild_channel_started on session_candidates(guild_id, channel_id, started_at desc);
create index if not exists idx_session_candidates_tracked_status on session_candidates(tracked_voice_channel_id, status);
create unique index if not exists idx_session_candidates_finalized_event on session_candidates(finalized_official_session_id) where finalized_official_session_id is not null;

create table if not exists candidate_participants (
  id uuid primary key default gen_random_uuid(),
  session_candidate_id uuid not null references session_candidates(id) on delete cascade,
  guild_id text not null,
  discord_user_id text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  total_presence_seconds integer not null,
  overlap_seconds integer not null,
  segment_count integer not null default 1,
  met_presence_threshold boolean not null default false,
  candidate_strength text not null,
  included_by_admin boolean,
  exclusion_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_candidate_id, discord_user_id),
  constraint candidate_participants_presence_non_negative_check check (total_presence_seconds >= 0),
  constraint candidate_participants_overlap_non_negative_check check (overlap_seconds >= 0),
  constraint candidate_participants_last_seen_after_first_seen_check check (last_seen_at >= first_seen_at),
  constraint candidate_participants_strength_check check (candidate_strength in ('strong', 'borderline', 'weak'))
);

create index if not exists idx_candidate_participants_candidate_strength on candidate_participants(session_candidate_id, candidate_strength);
create index if not exists idx_candidate_participants_guild_user_created on candidate_participants(guild_id, discord_user_id, created_at desc);

alter table events add column if not exists source_type text not null default 'manual';
alter table events add column if not exists source_candidate_id uuid references session_candidates(id) on delete set null;
alter table events add column if not exists source_channel_id text;
alter table events add column if not exists source_game_key text;

do $$
begin
  alter table events
    add constraint events_source_type_check
    check (source_type in ('manual', 'vc_candidate'));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table events
    add constraint events_vc_candidate_source_required_check
    check (
      (source_type = 'manual' and source_candidate_id is null)
      or (source_type = 'vc_candidate' and source_candidate_id is not null)
    );
exception
  when duplicate_object then null;
end $$;

create unique index if not exists idx_events_source_candidate_id on events(source_candidate_id) where source_candidate_id is not null;

alter table tracked_voice_channels enable row level security;
alter table voice_presence_segments enable row level security;
alter table session_candidates enable row level security;
alter table candidate_participants enable row level security;

insert into schema_migrations (version, name)
values ('006_vc_assisted_phase1_foundation', 'VC-assisted session capture Phase 1 foundation')
on conflict (version) do nothing;

commit;
