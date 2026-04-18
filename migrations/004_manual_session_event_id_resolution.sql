begin;

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
#variable_conflict use_column
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

create or replace function void_manual_session_event(
  p_request_id text,
  p_guild_id text,
  p_event_id uuid,
  p_actor_discord_id text,
  p_reason text
)
returns table (
  event_id uuid,
  already_voided boolean,
  participant_ids text[]
)
language plpgsql
as $$
#variable_conflict use_column
declare
  v_event events%rowtype;
  v_updated events%rowtype;
  v_participant_ids text[];
  v_before jsonb;
  v_after jsonb;
begin
  select *
  into v_event
  from events
  where id = p_event_id
    and guild_id = p_guild_id;

  if v_event.id is null then
    raise exception 'event_not_found';
  end if;

  select coalesce(array_agg(discord_id order by discord_id), array[]::text[])
  into v_participant_ids
  from event_attendance
  where event_id = p_event_id
    and guild_id = p_guild_id;

  if v_event.voided_at is not null then
    event_id := v_event.id;
    already_voided := true;
    participant_ids := v_participant_ids;
    return next;
  end if;

  update events
  set
    voided_at = now(),
    voided_by = p_actor_discord_id,
    void_reason = p_reason
  where id = p_event_id
    and guild_id = p_guild_id
    and voided_at is null
  returning *
  into v_updated;

  if v_updated.id is null then
    event_id := v_event.id;
    already_voided := true;
    participant_ids := v_participant_ids;
    return next;
  end if;

  v_before := to_jsonb(v_event) || jsonb_build_object('participant_ids', v_participant_ids);
  v_after := to_jsonb(v_updated) || jsonb_build_object('participant_ids', v_participant_ids);

  perform record_admin_correction(
    p_request_id,
    p_guild_id,
    p_actor_discord_id,
    'void_manual_session',
    'event',
    p_event_id::text,
    p_reason,
    v_before,
    v_after,
    jsonb_build_object('participant_ids', v_participant_ids)
  );

  event_id := v_updated.id;
  already_voided := false;
  participant_ids := v_participant_ids;
  return next;
end;
$$;

insert into schema_migrations (version, name)
values ('004_manual_session_event_id_resolution', 'Resolve manual session event_id ambiguity')
on conflict (version) do nothing;

commit;
