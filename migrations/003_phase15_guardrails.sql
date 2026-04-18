begin;

alter table events add column if not exists voided_at timestamptz;
alter table events add column if not exists voided_by text;
alter table events add column if not exists void_reason text;

create index if not exists idx_events_active_started
  on events(guild_id, started_at desc)
  where voided_at is null;

create table if not exists pending_repairs (
  repair_type   text not null,
  scope_key     text not null,
  guild_id      text not null,
  status        text not null default 'pending',
  requested_by  text,
  request_id    text,
  last_error    text,
  attempts      integer not null default 0,
  metadata      jsonb default '{}'::jsonb,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  primary key (repair_type, scope_key)
);

create index if not exists idx_pending_repairs_status_updated
  on pending_repairs(status, updated_at desc);

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
values ('003_phase15_guardrails', 'Phase 1.5 guardrails')
on conflict (version) do nothing;

commit;
