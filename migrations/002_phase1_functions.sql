begin;

create or replace function acquire_job_lock(
  p_job_type text,
  p_scope_key text,
  p_owner_id text,
  p_lease_seconds integer
)
returns boolean
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_expires timestamptz := now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 30));
begin
  insert into job_runs (
    job_type,
    scope_key,
    owner_id,
    status,
    started_at,
    updated_at,
    lease_expires_at,
    metadata
  )
  values (
    p_job_type,
    p_scope_key,
    p_owner_id,
    'running',
    v_now,
    v_now,
    v_expires,
    '{}'::jsonb
  )
  on conflict do nothing;

  if found then
    return true;
  end if;

  update job_runs
  set
    owner_id = p_owner_id,
    status = 'running',
    started_at = v_now,
    updated_at = v_now,
    finished_at = null,
    error_message = null,
    lease_expires_at = v_expires
  where job_type = p_job_type
    and scope_key = p_scope_key
    and (lease_expires_at <= v_now or status in ('completed', 'failed'));

  return found;
end;
$$;

create or replace function release_job_lock(
  p_job_type text,
  p_scope_key text,
  p_owner_id text,
  p_status text,
  p_error_message text default null
)
returns boolean
language plpgsql
as $$
begin
  update job_runs
  set
    status = p_status,
    updated_at = now(),
    finished_at = now(),
    error_message = p_error_message,
    lease_expires_at = now()
  where job_type = p_job_type
    and scope_key = p_scope_key
    and owner_id = p_owner_id;

  return found;
end;
$$;

create or replace function log_manual_session(
  p_request_id text,
  p_guild_id text,
  p_game_type text,
  p_session_type text,
  p_winner_id text,
  p_mvp_id text,
  p_notes text,
  p_logged_by text,
  p_participant_ids text[]
)
returns table (
  event_id uuid,
  created boolean,
  started_at timestamptz
)
language plpgsql
as $$
declare
  v_event events%rowtype;
  v_created boolean := false;
  v_participant_ids text[];
begin
  if p_request_id is null or length(trim(p_request_id)) = 0 then
    raise exception 'request_id required';
  end if;

  v_participant_ids := array(
    select distinct participant_id
    from unnest(coalesce(p_participant_ids, array[]::text[])) as participant_id
    where participant_id is not null
      and length(trim(participant_id)) > 0
  );

  if coalesce(array_length(v_participant_ids, 1), 0) = 0 then
    raise exception 'participant_ids required';
  end if;

  insert into events (
    request_id,
    guild_id,
    game_type,
    session_type,
    winner_id,
    mvp_id,
    notes,
    logged_by
  )
  values (
    p_request_id,
    p_guild_id,
    p_game_type,
    p_session_type,
    p_winner_id,
    p_mvp_id,
    p_notes,
    p_logged_by
  )
  on conflict (request_id) do nothing
  returning * into v_event;

  if v_event.id is null then
    select *
    into v_event
    from events
    where request_id = p_request_id;

    v_created := false;
  else
    v_created := true;

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
      v_event.started_at
    from unnest(v_participant_ids) as participant_id
    on conflict on constraint idx_event_attendance_event_player do nothing;

    insert into audit_logs (
      guild_id,
      actor_discord_id,
      action_type,
      target_type,
      target_id,
      request_id,
      after_json,
      metadata
    )
    values (
      p_guild_id,
      p_logged_by,
      case
        when p_session_type = 'competitive' then 'manual_session_competitive_logged'
        else 'manual_session_attendance_logged'
      end,
      'event',
      v_event.id::text,
      p_request_id,
      jsonb_build_object(
        'game_type', v_event.game_type,
        'session_type', v_event.session_type,
        'winner_id', v_event.winner_id,
        'mvp_id', v_event.mvp_id,
        'participant_count', coalesce(array_length(v_participant_ids, 1), 0)
      ),
      jsonb_build_object(
        'participant_ids', v_participant_ids
      )
    )
    on conflict do nothing;
  end if;

  event_id := v_event.id;
  created := v_created;
  started_at := v_event.started_at;
  return next;
end;
$$;

create or replace function record_admin_correction(
  p_request_id text,
  p_guild_id text,
  p_actor_discord_id text,
  p_correction_type text,
  p_target_type text,
  p_target_id text,
  p_reason text,
  p_before_json jsonb default null,
  p_after_json jsonb default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
as $$
declare
  v_correction_id uuid;
begin
  if p_guild_id is null or length(trim(p_guild_id)) = 0 then
    raise exception 'guild_id required';
  end if;

  if p_actor_discord_id is null or length(trim(p_actor_discord_id)) = 0 then
    raise exception 'actor_discord_id required';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason required';
  end if;

  insert into admin_corrections (
    guild_id,
    actor_discord_id,
    correction_type,
    target_type,
    target_id,
    request_id,
    reason,
    before_json,
    after_json,
    metadata
  )
  values (
    p_guild_id,
    p_actor_discord_id,
    p_correction_type,
    p_target_type,
    p_target_id,
    p_request_id,
    p_reason,
    p_before_json,
    p_after_json,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict do nothing
  returning id into v_correction_id;

  if v_correction_id is null and p_request_id is not null then
    select id
    into v_correction_id
    from admin_corrections
    where request_id = p_request_id;
  end if;

  if v_correction_id is not null then
    insert into audit_logs (
      guild_id,
      actor_discord_id,
      action_type,
      target_type,
      target_id,
      request_id,
      reason,
      before_json,
      after_json,
      metadata
    )
    values (
      p_guild_id,
      p_actor_discord_id,
      'admin_correction_recorded',
      p_target_type,
      p_target_id,
      p_request_id,
      p_reason,
      p_before_json,
      p_after_json,
      jsonb_build_object('correction_id', v_correction_id) || coalesce(p_metadata, '{}'::jsonb)
    )
    on conflict do nothing;
  end if;

  return v_correction_id;
end;
$$;

insert into schema_migrations (version, name)
values ('002_phase1_functions', 'Phase 1 SQL helper functions')
on conflict (version) do nothing;

commit;
