# Staging Test Plan

Use this plan against staging first, not broad production.

## Environment

1. Use a staging Discord application and staging bot token.
2. Use a staging Supabase project with the full migration bundle applied.
3. Deploy commands with `npm run deploy:guild`.
4. Prefer one app instance for normal staging validation.
5. Use two instances only for targeted recovery and throttle checks.

## Baseline checks

1. Start the bot and confirm startup migration verification passes.
2. Confirm `/setup` already exists and the guild is configured.
3. Confirm `/vc` and `/session` commands are visible after guild deploy.
4. Run `npm test` locally before staging verification.

## VC default profile checks

1. Run `/vc track` on a normal voice channel.
2. Verify `/vc list` shows:
   - channel
   - default game
   - default session type
   - enabled state
3. Run `/vc config` and confirm the advanced rules change.
4. Run `/vc untrack` and confirm tracking disables cleanly.

## Candidate lifecycle checks

1. Put enough human test accounts into a tracked VC to meet the threshold.
2. Hold the threshold long enough for candidate open.
3. Verify `/session candidates` shows an `open` candidate.
4. Drop below threshold long enough for close.
5. Verify the candidate closes and builds participant rows.
6. Inspect the candidate with `/session candidate`.

Verify the detail view shows:

- participant rows
- schedule context
- locked roster when present

## Scheduling checks

1. Create a schedule with `/session schedule`.
2. Verify `/session upcoming` shows it.
3. Reschedule it with `/session reschedule`.
4. Cancel a different scheduled session with `/session cancel`.
5. Verify only `scheduled` rows appear in `/session upcoming`.

## Schedule-aware candidate context checks

1. Create one scheduled session whose linked VC and time window clearly match the candidate.
2. Trigger a candidate in that VC.
3. Verify the candidate detail shows matched schedule context.
4. Create an ambiguity case with two schedules in the same candidate window.
5. Verify the candidate stays unlinked and shows ambiguous schedule context.

## Lock-in draft checks

1. Use `/session lockin` on a closed candidate with explicit `players`.
2. Verify `/session candidate` shows the locked roster.
3. Run `/session lockin` again on the same candidate with a different roster.
4. Verify the draft is replaced, not duplicated.
5. Run `/session lockin` without `players`.
6. Verify the draft defaults to threshold-qualified candidate participants.

## Finalize checks

1. Finalize a closed candidate without passing `players`.
2. Verify the locked roster is used when present.
3. Finalize another candidate with an explicit `players` override.
4. Verify the explicit roster wins over any lock-in draft.
5. Finalize with a valid `scheduled_session_id`.
6. Verify the official event links to the schedule and the schedule becomes `completed`.
7. Verify the candidate becomes `finalized`.
8. Verify official stats change only after finalize.

## Discard checks

1. Discard a closed candidate with `/session discard`.
2. Verify no official event is created.
3. Verify official stats do not change.

## Manual session checks

1. Run `/session attendance`.
2. Run `/session log`.
3. Verify official stats update.
4. Run `/session correct` against a manual session.
5. Verify the correction lands and stats rebuild.

## Recovery checks

1. Put two human users into a tracked VC.
2. Restart the bot while the VC is still active.
3. Verify recovery runs after the warm-up delay.
4. Verify the live VC session is not double-closed.
5. Verify the candidate timing path recovers correctly when a candidate is open.

## Multi-instance checks

1. Start two staging bot instances against the same staging database.
2. Restart both and verify only one acquires the VC recovery lock.
3. Fire the same mutating command rapidly across both instances.
4. Record whether the in-memory throttle can be bypassed across instances.

If cross-instance throttling is bypassed, keep beta limited to one app instance.

## Repair queue checks

1. Force the stats rebuild path to fail after a successful finalize or manual session write.
2. Verify a `pending_repairs` row is queued.
3. Restore normal behavior.
4. Verify the repair completes later.

## Current release caveats to watch during staging

- restart recovery still relies on Discord cache state after warm-up
- schedule matching is evidence only and should never be mistaken for official truth
- lock-in drafts are not official until finalize
- automated coverage is still light relative to the runtime state space
