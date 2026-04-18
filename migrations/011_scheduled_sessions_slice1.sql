begin;

create table if not exists scheduled_sessions (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  game_key text not null,
  session_type text not null,
  scheduled_start_at timestamptz not null,
  input_timezone text,
  linked_channel_id text,
  host_discord_user_id text,
  notes text,
  status text not null default 'scheduled',
  completed_event_id uuid references events(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by_discord_user_id text,
  cancel_reason text,
  created_by_discord_user_id text not null,
  updated_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_sessions_status_check check (status in ('scheduled', 'cancelled', 'completed')),
  constraint scheduled_sessions_completed_state_check check (
    (status = 'completed' and completed_event_id is not null)
    or (status <> 'completed' and completed_event_id is null)
  ),
  constraint scheduled_sessions_cancelled_state_check check (
    (status = 'cancelled' and cancelled_at is not null and cancelled_by_discord_user_id is not null)
    or (status <> 'cancelled' and cancelled_at is null and cancelled_by_discord_user_id is null and cancel_reason is null)
  )
);

create index if not exists idx_scheduled_sessions_guild_status_start
  on scheduled_sessions(guild_id, status, scheduled_start_at asc);

create index if not exists idx_scheduled_sessions_guild_channel_start
  on scheduled_sessions(guild_id, linked_channel_id, scheduled_start_at desc);

create unique index if not exists idx_scheduled_sessions_completed_event
  on scheduled_sessions(completed_event_id)
  where completed_event_id is not null;

alter table events add column if not exists scheduled_session_id uuid references scheduled_sessions(id) on delete set null;

create unique index if not exists idx_events_scheduled_session_id
  on events(scheduled_session_id)
  where scheduled_session_id is not null;

alter table scheduled_sessions enable row level security;

create or replace function finalize_session_candidate(
  p_request_id text,
  p_guild_id text,
  p_candidate_id uuid,
  p_actor_discord_id text,
  p_participant_ids text[],
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
  v_candidate session_candidates%rowtype;
  v_event events%rowtype;
  v_schedule scheduled_sessions%rowtype;
  v_created boolean := false;
  v_participant_ids text[];
  v_participant_count integer;
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
  into v_candidate
  from session_candidates
  where id = p_candidate_id
    and guild_id = p_guild_id;

  if v_candidate.id is null then
    raise exception 'candidate_not_found';
  end if;

  if v_candidate.status = 'finalized' then
    raise exception 'candidate_already_finalized';
  end if;

  if v_candidate.status = 'discarded' then
    raise exception 'candidate_discarded';
  end if;

  if v_candidate.status <> 'closed' then
    raise exception 'candidate_not_closed';
  end if;

  if p_scheduled_session_id is not null then
    select *
    into v_schedule
    from scheduled_sessions
    where id = p_scheduled_session_id
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

  v_participant_ids := array(
    select distinct participant_id
    from unnest(coalesce(p_participant_ids, array[]::text[])) as participant_id
    where participant_id is not null
      and length(trim(participant_id)) > 0
    order by participant_id
  );

  if coalesce(array_length(v_participant_ids, 1), 0) = 0 then
    raise exception 'participant_ids_required';
  end if;

  select count(*)
  into v_participant_count
  from candidate_participants
  where session_candidate_id = p_candidate_id
    and guild_id = p_guild_id
    and discord_user_id = any(v_participant_ids);

  if v_participant_count <> coalesce(array_length(v_participant_ids, 1), 0) then
    raise exception 'invalid_participant_ids';
  end if;

  if p_winner_id is not null and not (p_winner_id = any(v_participant_ids)) then
    raise exception 'winner_not_in_participants';
  end if;

  if p_mvp_id is not null and not (p_mvp_id = any(v_participant_ids)) then
    raise exception 'mvp_not_in_participants';
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
    source_candidate_id,
    source_channel_id,
    source_game_key,
    scheduled_session_id
  )
  values (
    p_request_id,
    p_guild_id,
    v_candidate.game_key,
    v_candidate.session_type,
    p_winner_id,
    p_mvp_id,
    p_notes,
    p_actor_discord_id,
    v_candidate.started_at,
    'vc_candidate',
    v_candidate.id,
    v_candidate.channel_id,
    v_candidate.game_key,
    p_scheduled_session_id
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

    if v_event.source_candidate_id is distinct from p_candidate_id then
      raise exception 'request_id_conflict';
    end if;

    if p_scheduled_session_id is not null and v_event.scheduled_session_id is distinct from p_scheduled_session_id then
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
    v_candidate.started_at
  from unnest(v_participant_ids) as participant_id
  on conflict on constraint idx_event_attendance_event_player do nothing;

  update candidate_participants
  set
    included_by_admin = discord_user_id = any(v_participant_ids),
    exclusion_reason = case
      when discord_user_id = any(v_participant_ids) then null
      else coalesce(exclusion_reason, 'not_selected_in_finalize')
    end,
    updated_at = now()
  where session_candidate_id = p_candidate_id
    and guild_id = p_guild_id;

  update session_candidates
  set
    status = 'finalized',
    finalized_official_session_id = v_event.id,
    finalized_by_discord_user_id = p_actor_discord_id,
    updated_at = now()
  where id = p_candidate_id
    and guild_id = p_guild_id
    and status = 'closed';

  if not found then
    raise exception 'candidate_finalize_update_failed';
  end if;

  if p_scheduled_session_id is not null then
    update scheduled_sessions
    set
      status = 'completed',
      completed_event_id = v_event.id,
      updated_by_discord_user_id = p_actor_discord_id,
      updated_at = now()
    where id = p_scheduled_session_id
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
values ('011_scheduled_sessions_slice1', 'Scheduled sessions slice 1')
on conflict (version) do nothing;

commit;
