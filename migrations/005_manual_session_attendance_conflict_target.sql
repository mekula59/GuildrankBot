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
    on conflict (event_id, discord_id) do nothing;

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

insert into schema_migrations (version, name)
values ('005_manual_session_attendance_conflict_target', 'Fix manual session attendance conflict target')
on conflict (version) do nothing;

commit;
