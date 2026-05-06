begin;

create table if not exists live_sessions (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  tracked_voice_channel_id uuid references tracked_voice_channels(id) on delete set null,
  channel_id text not null,
  channel_name_snapshot text not null,
  game_key text not null,
  session_type text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null default 'live',
  start_context_type text not null,
  source_candidate_id uuid references session_candidates(id) on delete set null,
  scheduled_session_id uuid references scheduled_sessions(id) on delete set null,
  notes text,
  winner_discord_user_id text,
  mvp_discord_user_id text,
  finalized_official_event_id uuid references events(id) on delete set null,
  created_by_discord_user_id text not null,
  updated_by_discord_user_id text not null,
  ended_by_discord_user_id text,
  finalized_by_discord_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint live_sessions_status_check check (status in ('live', 'ended', 'finalized')),
  constraint live_sessions_start_context_check check (start_context_type in ('candidate', 'scheduled_session', 'tracked_vc')),
  constraint live_sessions_ended_state_check check (
    (status = 'live' and ended_at is null and ended_by_discord_user_id is null)
    or (status <> 'live' and ended_at is not null and ended_by_discord_user_id is not null)
  ),
  constraint live_sessions_finalized_state_check check (
    (status = 'finalized' and finalized_official_event_id is not null and finalized_by_discord_user_id is not null)
    or (status <> 'finalized' and finalized_official_event_id is null and finalized_by_discord_user_id is null)
  )
);

create index if not exists idx_live_sessions_guild_status_started
  on live_sessions(guild_id, status, started_at desc);

create index if not exists idx_live_sessions_guild_channel_started
  on live_sessions(guild_id, channel_id, started_at desc);

create unique index if not exists idx_live_sessions_single_live_per_channel
  on live_sessions(guild_id, channel_id)
  where status = 'live';

create unique index if not exists idx_live_sessions_source_candidate
  on live_sessions(source_candidate_id)
  where source_candidate_id is not null;

create unique index if not exists idx_live_sessions_finalized_event
  on live_sessions(finalized_official_event_id)
  where finalized_official_event_id is not null;

create table if not exists live_session_people (
  id uuid primary key default gen_random_uuid(),
  live_session_id uuid not null references live_sessions(id) on delete cascade,
  guild_id text not null,
  discord_user_id text not null,
  roster_role text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (live_session_id, discord_user_id),
  constraint live_session_people_role_check check (roster_role in ('player', 'spectator')),
  constraint live_session_people_source_check check (source in ('lockin_draft', 'candidate_threshold', 'candidate_observed', 'vc_current_occupant', 'manual'))
);

create index if not exists idx_live_session_people_guild_user_created
  on live_session_people(guild_id, discord_user_id, created_at desc);

alter table events add column if not exists source_live_session_id uuid references live_sessions(id) on delete set null;

create unique index if not exists idx_events_source_live_session_id
  on events(source_live_session_id)
  where source_live_session_id is not null;

alter table events drop constraint if exists events_source_type_check;
alter table events drop constraint if exists events_vc_candidate_source_required_check;
alter table events drop constraint if exists events_source_reference_check;

do $$
begin
  alter table events
    add constraint events_source_type_check
    check (source_type in ('manual', 'vc_candidate', 'live_session'));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table events
    add constraint events_source_reference_check
    check (
      (source_type = 'manual' and source_candidate_id is null and source_live_session_id is null)
      or (source_type = 'vc_candidate' and source_candidate_id is not null and source_live_session_id is null)
      or (source_type = 'live_session' and source_candidate_id is null and source_live_session_id is not null)
    );
exception
  when duplicate_object then null;
end $$;

alter table live_sessions enable row level security;
alter table live_session_people enable row level security;

create or replace function finalize_live_session(
  p_request_id text,
  p_guild_id text,
  p_live_session_id uuid,
  p_actor_discord_id text,
  p_player_ids text[],
  p_notes text default null,
  p_winner_id text default null,
  p_mvp_id text default null,
  p_scheduled_session_id uuid default null
)
returns table (
  event_id uuid,
  created boolean,
  started_at timestamptz
)
language plpgsql
as $$
#variable_conflict use_column
declare
  v_live_session live_sessions%rowtype;
  v_event events%rowtype;
  v_schedule scheduled_sessions%rowtype;
  v_created boolean := false;
  v_player_ids text[];
  v_player_count integer;
  v_effective_schedule_id uuid;
begin
  if p_request_id is null or length(trim(p_request_id)) = 0 then
    raise exception 'request_id_required';
  end if;

  if p_guild_id is null or length(trim(p_guild_id)) = 0 then
    raise exception 'guild_id_required';
  end if;

  if p_actor_discord_id is null or length(trim(p_actor_discord_id)) = 0 then
    raise exception 'actor_discord_id_required';
  end if;

  select *
  into v_live_session
  from live_sessions
  where id = p_live_session_id
    and guild_id = p_guild_id;

  if v_live_session.id is null then
    raise exception 'live_session_not_found';
  end if;

  if v_live_session.status = 'finalized' then
    select *
    into v_event
    from events
    where request_id = p_request_id;

    if v_event.id is not null and v_event.source_live_session_id = p_live_session_id then
      event_id := v_event.id;
      created := false;
      started_at := v_event.started_at;
      return next;
    end if;

    raise exception 'live_session_already_finalized';
  end if;

  if v_live_session.status <> 'ended' then
    raise exception 'live_session_not_ended';
  end if;

  v_effective_schedule_id := coalesce(p_scheduled_session_id, v_live_session.scheduled_session_id);

  if v_effective_schedule_id is not null then
    select *
    into v_schedule
    from scheduled_sessions
    where id = v_effective_schedule_id
      and guild_id = p_guild_id;

    if v_schedule.id is null then
      raise exception 'scheduled_session_not_found';
    end if;

    if v_schedule.status = 'cancelled' then
      raise exception 'scheduled_session_cancelled';
    end if;

    if v_schedule.status = 'completed' and v_schedule.completed_event_id is not null then
      raise exception 'scheduled_session_already_completed';
    end if;
  end if;

  v_player_ids := array(
    select distinct participant_id
    from unnest(coalesce(p_player_ids, array[]::text[])) as participant_id
    where participant_id is not null
      and length(trim(participant_id)) > 0
    order by participant_id
  );

  if coalesce(array_length(v_player_ids, 1), 0) = 0 then
    raise exception 'live_session_players_required';
  end if;

  select count(*)
  into v_player_count
  from live_session_people
  where live_session_id = p_live_session_id
    and guild_id = p_guild_id
    and roster_role = 'player'
    and discord_user_id = any(v_player_ids);

  if v_player_count <> coalesce(array_length(v_player_ids, 1), 0) then
    raise exception 'invalid_live_session_player_ids';
  end if;

  if p_winner_id is not null and not (p_winner_id = any(v_player_ids)) then
    raise exception 'winner_not_in_players';
  end if;

  if p_mvp_id is not null and not (p_mvp_id = any(v_player_ids)) then
    raise exception 'mvp_not_in_players';
  end if;

  insert into events (
    request_id,
    guild_id,
    game_type,
    session_type,
    winner_id,
    mvp_id,
    notes,
    logged_by,
    started_at,
    source_type,
    source_live_session_id,
    source_channel_id,
    source_game_key,
    scheduled_session_id
  )
  values (
    p_request_id,
    p_guild_id,
    v_live_session.game_key,
    v_live_session.session_type,
    p_winner_id,
    p_mvp_id,
    p_notes,
    p_actor_discord_id,
    v_live_session.started_at,
    'live_session',
    v_live_session.id,
    v_live_session.channel_id,
    v_live_session.game_key,
    v_effective_schedule_id
  )
  on conflict (request_id) do nothing
  returning * into v_event;

  if v_event.id is null then
    select *
    into v_event
    from events
    where request_id = p_request_id;

    if v_event.id is null then
      raise exception 'finalize_request_resolution_failed';
    end if;

    if v_event.source_live_session_id is distinct from p_live_session_id then
      raise exception 'request_id_conflict';
    end if;

    if v_effective_schedule_id is not null and v_event.scheduled_session_id is distinct from v_effective_schedule_id then
      raise exception 'request_id_conflict';
    end if;

    v_created := false;
  else
    v_created := true;
  end if;

  insert into event_attendance (
    event_id,
    discord_id,
    guild_id,
    joined_at
  )
  select
    v_event.id,
    participant_id,
    p_guild_id,
    v_live_session.started_at
  from unnest(v_player_ids) as participant_id
  on conflict on constraint idx_event_attendance_event_player do nothing;

  update live_sessions
  set
    status = 'finalized',
    ended_at = coalesce(ended_at, now()),
    notes = p_notes,
    winner_discord_user_id = p_winner_id,
    mvp_discord_user_id = p_mvp_id,
    scheduled_session_id = v_effective_schedule_id,
    finalized_official_event_id = v_event.id,
    updated_by_discord_user_id = p_actor_discord_id,
    ended_by_discord_user_id = coalesce(ended_by_discord_user_id, p_actor_discord_id),
    finalized_by_discord_user_id = p_actor_discord_id,
    updated_at = now()
  where id = p_live_session_id
    and guild_id = p_guild_id
    and status in ('ended', 'finalized')
    and (finalized_official_event_id is null or finalized_official_event_id = v_event.id);

  if not found then
    raise exception 'live_session_finalize_update_failed';
  end if;

  if v_live_session.source_candidate_id is not null then
    update session_candidates
    set
      status = 'finalized',
      finalized_official_session_id = v_event.id,
      finalized_by_discord_user_id = p_actor_discord_id,
      updated_at = now()
    where id = v_live_session.source_candidate_id
      and guild_id = p_guild_id
      and status in ('closed', 'finalized')
      and (finalized_official_session_id is null or finalized_official_session_id = v_event.id);

    if not found then
      raise exception 'live_session_candidate_link_failed';
    end if;
  end if;

  if v_effective_schedule_id is not null then
    update scheduled_sessions
    set
      status = 'completed',
      completed_event_id = v_event.id,
      updated_by_discord_user_id = p_actor_discord_id,
      updated_at = now()
    where id = v_effective_schedule_id
      and guild_id = p_guild_id
      and status in ('scheduled', 'completed')
      and (completed_event_id is null or completed_event_id = v_event.id);

    if not found then
      raise exception 'scheduled_session_link_failed';
    end if;
  end if;

  event_id := v_event.id;
  created := v_created;
  started_at := v_event.started_at;
  return next;
end;
$$;

insert into schema_migrations (version, name)
values ('014_live_sessions', 'Live session draft layer')
on conflict (version) do nothing;

commit;
