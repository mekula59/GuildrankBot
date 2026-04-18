begin;

alter table session_candidates
  add column if not exists min_active_members_snapshot integer,
  add column if not exists min_candidate_duration_minutes_snapshot integer,
  add column if not exists min_participant_presence_minutes_snapshot integer,
  add column if not exists grace_gap_seconds_snapshot integer;

update session_candidates
set
  min_active_members_snapshot = coalesce(min_active_members_snapshot, 2),
  min_candidate_duration_minutes_snapshot = coalesce(min_candidate_duration_minutes_snapshot, 10),
  min_participant_presence_minutes_snapshot = coalesce(min_participant_presence_minutes_snapshot, 5),
  grace_gap_seconds_snapshot = coalesce(grace_gap_seconds_snapshot, 180),
  updated_at = now()
where min_active_members_snapshot is null
   or min_candidate_duration_minutes_snapshot is null
   or min_participant_presence_minutes_snapshot is null
   or grace_gap_seconds_snapshot is null;

alter table session_candidates
  alter column min_active_members_snapshot set default 2,
  alter column min_active_members_snapshot set not null,
  alter column min_candidate_duration_minutes_snapshot set default 10,
  alter column min_candidate_duration_minutes_snapshot set not null,
  alter column min_participant_presence_minutes_snapshot set default 5,
  alter column min_participant_presence_minutes_snapshot set not null,
  alter column grace_gap_seconds_snapshot set default 180,
  alter column grace_gap_seconds_snapshot set not null;

do $$
begin
  alter table session_candidates
    add constraint session_candidates_min_active_members_snapshot_check
    check (min_active_members_snapshot >= 2);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table session_candidates
    add constraint session_candidates_min_candidate_duration_snapshot_check
    check (min_candidate_duration_minutes_snapshot >= 1);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table session_candidates
    add constraint session_candidates_min_participant_presence_snapshot_check
    check (min_participant_presence_minutes_snapshot >= 1);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table session_candidates
    add constraint session_candidates_grace_gap_snapshot_check
    check (grace_gap_seconds_snapshot >= 0);
exception
  when duplicate_object then null;
end $$;

insert into schema_migrations (version, name)
values ('010_vc_candidate_threshold_snapshots', 'VC-assisted candidate threshold snapshots')
on conflict (version) do nothing;

commit;
