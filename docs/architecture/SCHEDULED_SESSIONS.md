# Scheduled Sessions

## Purpose

Scheduled sessions let guild operators store planned session intent without turning that plan into official truth.

This is important for communities that reuse the same voice channels for different games on different days.

Examples:

- Monday 17:00 UTC in one VC means `codm`
- Friday 17:00 UTC in the same VC means `among_us`

## Current scope

Implemented now:

- `scheduled_sessions` schema
- `/session schedule`
- `/session upcoming`
- `/session cancel`
- `/session reschedule`
- optional manual linkage from finalize to a scheduled session
- conservative schedule context matching for candidates

Not implemented now:

- automatic schedule-driven finalize
- schedule-driven automatic override of candidate game or type
- `/session live`
- player check-in or lock-in from the schedule layer

## Data model

Current table: `scheduled_sessions`

Important fields:

- `guild_id`
- `game_key`
- `session_type`
- `scheduled_start_at`
- `input_timezone`
- `linked_channel_id`
- `host_discord_user_id`
- `notes`
- `status`
- `completed_event_id`

Current statuses:

- `scheduled`
- `cancelled`
- `completed`

All schedule rows are guild-scoped.

## UTC handling

GuildRank stores `scheduled_start_at` as UTC-safe `timestamptz`.

Current command input expects:

- ISO datetime with `Z`, or
- ISO datetime with an explicit offset

Examples:

- `2026-05-01T17:00:00Z`
- `2026-05-01T18:00:00+01:00`

The optional timezone field is currently a display and audit label, not a conversion source of truth.

## Command surface

### `/session schedule`

Creates a new scheduled session with:

- `game`
- `session_type`
- `start_time`
- optional `timezone`
- optional `voice_channel`
- optional `host`
- optional `notes`

### `/session upcoming`

Lists scheduled sessions with `status = scheduled`.

### `/session cancel`

Moves a scheduled session from `scheduled` to `cancelled`.

Completed schedules cannot be cancelled.

### `/session reschedule`

Updates a still-scheduled session.

Current editable fields:

- start time
- timezone label
- game
- session type
- linked voice channel
- host
- notes

Cancelled or completed schedules cannot be rescheduled.

## Candidate schedule context

GuildRank now lets a candidate carry optional schedule context.

This is stored on the candidate as:

- `scheduled_session_id`
- `schedule_match_status`
- `schedule_match_checked_at`

Current match statuses:

- `matched`
- `ambiguous`
- `none`

## Current matching rules

The candidate schedule matcher is deliberately conservative.

Rules:

- same guild only
- schedule must still be `scheduled`
- if the schedule has a linked VC, it must match the candidate channel
- candidate start time must fall within the configured time window
- if multiple schedules match, GuildRank does not auto-link any of them

Current time window:

- 45 minutes before scheduled start
- 90 minutes after scheduled start

## Evidence vs official truth

This is the most important rule in the current implementation.

### Schedule intent

A scheduled session means:

- an operator planned something

It does **not** mean:

- the session happened
- the VC occupants were actual players
- official stats should change

### Candidate schedule match

A matched schedule on a candidate means:

- GuildRank found one plausible planned context for that candidate

It does **not** mean:

- the candidate is automatically official
- the candidate game or type is automatically overridden
- the official session is automatically linked

### Finalize linkage

An operator may explicitly pass `scheduled_session_id` during `/session finalize`.

If the scheduled session is valid:

- `events.scheduled_session_id` is set
- the schedule is marked `completed`

This is still a manual operator decision in the current implementation.

## Current operator workflow

1. Create a plan with `/session schedule`.
2. Let GuildRank observe VC activity and possibly attach schedule context to a candidate.
3. Review the candidate and its schedule context privately.
4. Optionally lock in a player roster.
5. Finalize manually, optionally passing the scheduled session ID.

## What affects stats

Does not affect stats:

- scheduled sessions
- cancelled schedules
- candidate schedule matches

Does affect stats:

- finalized official sessions

## Current limitations

- schedule matching is advisory only
- ambiguous schedule windows stay unlinked by design
- schedules do not yet drive automatic game or type inheritance at finalize time
- there is no schedule-native live roster workflow yet
- there is no automatic schedule completion without finalize
