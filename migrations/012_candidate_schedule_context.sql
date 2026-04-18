begin;

alter table session_candidates
  add column if not exists scheduled_session_id uuid references scheduled_sessions(id) on delete set null,
  add column if not exists schedule_match_status text not null default 'none',
  add column if not exists schedule_match_checked_at timestamptz;

update session_candidates
set
  schedule_match_status = coalesce(schedule_match_status, 'none'),
  schedule_match_checked_at = coalesce(schedule_match_checked_at, now()),
  updated_at = now()
where schedule_match_status is null
   or schedule_match_checked_at is null;

do $$
begin
  alter table session_candidates
    add constraint session_candidates_schedule_match_status_check
    check (schedule_match_status in ('none', 'matched', 'ambiguous'));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table session_candidates
    add constraint session_candidates_schedule_match_state_check
    check (
      (schedule_match_status = 'matched' and scheduled_session_id is not null)
      or (schedule_match_status <> 'matched' and scheduled_session_id is null)
    );
exception
  when duplicate_object then null;
end $$;

create index if not exists idx_session_candidates_schedule_match_status
  on session_candidates(guild_id, schedule_match_status, started_at desc);

create index if not exists idx_session_candidates_scheduled_session
  on session_candidates(scheduled_session_id)
  where scheduled_session_id is not null;

insert into schema_migrations (version, name)
values ('012_candidate_schedule_context', 'Candidate schedule context')
on conflict (version) do nothing;

commit;
