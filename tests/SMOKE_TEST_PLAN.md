# GuildRank Phase 1.5 Smoke Test Plan

Use this only against staging, never production first.

## Environment

1. Use a staging Discord application and staging bot token.
2. Use a staging Supabase project with the full migration bundle applied.
3. Deploy commands with `npm run deploy:guild`.
4. Start exactly two bot instances pointed at the same staging database.

## Startup and Recovery

1. Put two human test accounts into the same non-AFK voice channel.
2. Restart both bot instances at the same time.
3. Verify only one instance logs `job_lock_acquired` for `vc_recovery`.
4. Verify the open VC session resumes once and is not double-closed.

## Manual Session Idempotency

1. Run `/session attendance` once.
2. Re-run the same interaction path by forcing a retry or reusing the same interaction in a Discord retry simulation.
3. Verify only one `events` row exists for that `request_id`.
4. Verify `audit_logs` contains one manual session audit entry for that request.
5. Verify a moderator who has `ManageEvents` but does not have `ManageGuild` can see `/session`, can run `/session log`, and gets a successful response.

## Correction Workflow

1. Record a manual session with `/session log`.
2. Copy the full `event_id` from the database.
3. Run `/session correct event_id:<uuid> reason:<text> confirm:VOID`.
4. Verify `events.voided_at`, `voided_by`, and `void_reason` are set.
5. Verify `admin_corrections` contains one row.
6. Verify the leaderboard and `/stats` no longer count the voided event after rebuild.

## Repair Queue

1. Temporarily force the rebuild path to fail after a successful manual session insert.
2. Run `/session attendance`.
3. Verify `pending_repairs` contains a `guild_stats` row for that guild.
4. Restore normal behavior.
5. Wait for the repair cron or restart the bot.
6. Verify the pending repair moves to `completed`.

## Throttling

1. Fire `/session attendance` twice in quick succession as the same moderator.
2. Verify the second request is rejected with a cooldown message.
3. Run `/setup` twice quickly and verify it also throttles.
4. With two bot instances running, repeat the rapid `/session attendance` test and verify whether the second write can land through the other instance.
5. If cross-instance throttling is bypassed, record that as an accepted limited-beta limitation and keep limited beta to a single app instance.

## Setup Audit Failure

1. Force `audit_logs` inserts to fail temporarily in staging after `guild_configs` writes still succeed.
2. Run `/setup` to completion.
3. Verify the guild config is saved successfully.
4. Verify the user still receives the success confirmation embed.
5. Verify an internal `setup_audit_failed` log entry is emitted.

## Crash-Mid-Lock Recovery

1. Start two bot instances against the same staging database.
2. Force instance A to acquire the `vc_recovery` lock and terminate it before recovery completes.
3. Wait slightly longer than the configured lease window.
4. Verify instance B can then acquire `vc_recovery` and complete recovery successfully.
5. Repeat the same timing check for `stats_recalc` and `pending_repairs`.

## Weekly Digest Dedupe

1. Set the staging guild digest day to today.
2. Trigger the digest job twice.
3. Verify only one `weekly_digest_history` row for that guild and week ends in `sent`.
4. Verify only one digest message appears in the configured channel.
