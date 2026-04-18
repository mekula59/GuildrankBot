begin;

alter table session_candidates add column if not exists participant_snapshot_status text not null default 'pending';
alter table session_candidates add column if not exists participant_snapshot_refreshed_at timestamptz;
alter table session_candidates add column if not exists participant_snapshot_error text;

do $$
begin
  alter table session_candidates
    add constraint session_candidates_participant_snapshot_status_check
    check (participant_snapshot_status in ('pending', 'ready', 'failed'));
exception
  when duplicate_object then null;
end $$;

update tracked_voice_channels
set session_type = 'casual',
    updated_at = now()
where session_type = 'attendance';

update session_candidates
set session_type = 'casual',
    updated_at = now()
where session_type = 'attendance';

update events
set session_type = 'casual'
where session_type = 'attendance';

insert into schema_migrations (version, name)
values ('009_vc_assisted_prerelease_guardrails', 'VC-assisted pre-release guardrails')
on conflict (version) do nothing;

commit;
