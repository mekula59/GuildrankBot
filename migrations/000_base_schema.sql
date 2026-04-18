begin;

create extension if not exists pgcrypto;

create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz default now(),
  name       text not null
);

create table if not exists guild_configs (
  guild_id             text primary key,
  guild_name           text,
  is_setup             boolean default false,
  setup_by             text,
  announce_channel_id  text,
  community_type       text default 'mixed',
  digest_day           text default 'sunday',
  left_at              timestamptz,
  updated_at           timestamptz default now()
);

create table if not exists players (
  id          uuid primary key default gen_random_uuid(),
  discord_id  text not null,
  guild_id    text not null,
  username    text,
  avatar_url  text,
  updated_at  timestamptz default now(),
  unique(discord_id, guild_id)
);

create table if not exists vc_sessions (
  id               uuid primary key default gen_random_uuid(),
  discord_id       text not null,
  guild_id         text not null,
  channel_id       text,
  joined_at        timestamptz not null,
  left_at          timestamptz,
  duration_minutes integer,
  recovered        boolean default false
);

create table if not exists events (
  id           uuid primary key default gen_random_uuid(),
  guild_id     text not null,
  game_type    text not null,
  session_type text default 'casual',
  winner_id    text,
  mvp_id       text,
  notes        text,
  logged_by    text,
  started_at   timestamptz default now()
);

create table if not exists event_attendance (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid references events(id) on delete cascade,
  discord_id text not null,
  guild_id   text not null,
  joined_at  timestamptz default now()
);

create table if not exists player_stats (
  discord_id            text not null,
  guild_id              text not null,
  total_events          integer default 0,
  total_vc_sessions     integer default 0,
  total_manual_sessions integer default 0,
  total_vc_minutes      integer default 0,
  wins                  integer default 0,
  mvps                  integer default 0,
  current_streak        integer default 0,
  longest_streak        integer default 0,
  last_seen             timestamptz,
  last_seen_date        text,
  badges                text[] default '{}',
  updated_at            timestamptz default now(),
  primary key (discord_id, guild_id)
);

create unique index if not exists idx_players_discord_guild on players(discord_id, guild_id);
create unique index if not exists idx_event_attendance_event_player on event_attendance(event_id, discord_id);
create unique index if not exists idx_vc_single_open_session on vc_sessions(guild_id, discord_id) where left_at is null;
create index if not exists idx_ps_events on player_stats(guild_id, total_events desc);
create index if not exists idx_ps_streak on player_stats(guild_id, current_streak desc);
create index if not exists idx_ps_minutes on player_stats(guild_id, total_vc_minutes desc);
create index if not exists idx_ps_wins on player_stats(guild_id, wins desc);
create index if not exists idx_vc_open on vc_sessions(left_at) where left_at is null;
create index if not exists idx_vc_guild on vc_sessions(guild_id);
create index if not exists idx_events_guild_started on events(guild_id, started_at desc);
create index if not exists idx_event_attendance_guild on event_attendance(guild_id, discord_id);

insert into players (discord_id, guild_id, updated_at)
select distinct discord_id, guild_id, now()
from player_stats
where discord_id is not null and guild_id is not null
on conflict (discord_id, guild_id) do nothing;

insert into players (discord_id, guild_id, updated_at)
select distinct discord_id, guild_id, now()
from vc_sessions
where discord_id is not null and guild_id is not null
on conflict (discord_id, guild_id) do nothing;

insert into players (discord_id, guild_id, updated_at)
select distinct discord_id, guild_id, now()
from event_attendance
where discord_id is not null and guild_id is not null
on conflict (discord_id, guild_id) do nothing;

do $$
begin
  alter table player_stats
    add constraint player_stats_player_fk
    foreign key (discord_id, guild_id)
    references players(discord_id, guild_id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;

alter table guild_configs enable row level security;
alter table players enable row level security;
alter table vc_sessions enable row level security;
alter table player_stats enable row level security;
alter table events enable row level security;
alter table event_attendance enable row level security;

insert into schema_migrations (version, name)
values ('000_base_schema', 'Base GuildRank schema')
on conflict (version) do nothing;

commit;
