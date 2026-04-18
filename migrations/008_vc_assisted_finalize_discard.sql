begin;

do $$
begin
  alter table session_candidates
    add constraint session_candidates_finalized_state_check
    check (
      (status = 'finalized' and finalized_official_session_id is not null and finalized_by_discord_user_id is not null)
      or (status <> 'finalized' and finalized_official_session_id is null and finalized_by_discord_user_id is null)
    );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table session_candidates
    add constraint session_candidates_discarded_state_check
    check (
      (status = 'discarded' and discard_reason is not null and length(trim(discard_reason)) > 0 and discarded_by_discord_user_id is not null)
      or (status <> 'discarded' and discard_reason is null and discarded_by_discord_user_id is null)
    );
exception
  when duplicate_object then null;
end $$;

create or replace function finalize_session_candidate(
  p_request_id text,
  p_guild_id text,
  p_candidate_id uuid,
  p_actor_discord_id text,
  p_participant_ids text[],
  p_notes text default null,
  p_winner_id text default null,
  p_mvp_id text default null
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
    source_game_key
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
    v_candidate.game_key
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

  event_id := v_event.id;
  created := v_created;
  started_at := v_event.started_at;
  return next;
end;
$$;

create or replace function discard_session_candidate(
  p_guild_id text,
  p_candidate_id uuid,
  p_actor_discord_id text,
  p_reason text
)
returns table (
  candidate_id uuid,
  already_discarded boolean
)
language plpgsql
as $$
#variable_conflict use_column
declare
  v_candidate session_candidates%rowtype;
begin
  if p_guild_id is null or length(trim(p_guild_id)) = 0 then
    raise exception 'guild_id_required';
  end if;

  if p_actor_discord_id is null or length(trim(p_actor_discord_id)) = 0 then
    raise exception 'actor_discord_id_required';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'discard_reason_required';
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
    candidate_id := v_candidate.id;
    already_discarded := true;
    return next;
  end if;

  if v_candidate.status not in ('open', 'closed') then
    raise exception 'candidate_not_discardable';
  end if;

  update session_candidates
  set
    status = 'discarded',
    discard_reason = p_reason,
    discarded_by_discord_user_id = p_actor_discord_id,
    updated_at = now()
  where id = p_candidate_id
    and guild_id = p_guild_id
    and status in ('open', 'closed');

  if not found then
    raise exception 'candidate_discard_update_failed';
  end if;

  candidate_id := p_candidate_id;
  already_discarded := false;
  return next;
end;
$$;

insert into schema_migrations (version, name)
values ('008_vc_assisted_finalize_discard', 'VC-assisted finalize and discard lifecycle')
on conflict (version) do nothing;

commit;
