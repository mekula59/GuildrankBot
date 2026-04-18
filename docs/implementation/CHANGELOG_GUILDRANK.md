# GuildRank Changelog

This changelog is a practical implementation summary of what exists in the repo now.

## Current snapshot

GuildRank now supports:

- passive VC attendance and credited VC minutes
- manual session logging
- tracked VC defaults
- VC-assisted candidate detection
- candidate participant aggregation
- admin finalize and discard
- scheduled sessions
- schedule-aware candidate context
- admin lock-in drafts
- repair queue and startup guardrails

## Implementation slices

## Foundation

Initial GuildRank foundations established:

- multi-guild Discord bot structure
- source tables for players, stats, events, and attendance
- passive VC attendance tracking
- leaderboard, stats, and digest features

## Guardrails and corrections

Operational hardening added:

- versioned SQL migrations
- startup migration verification
- job locks for recurring jobs
- digest dedupe history
- audit logging for operator actions
- correction workflow for manual sessions
- queued stat repairs when rebuilds fail
- mutation throttles

## VC-assisted Phase 1 foundation

VC-assisted capture introduced:

- tracked voice channel configuration
- voice presence segment ingestion
- session candidate detection
- candidate participant aggregation
- candidate discard and finalize flow

## Candidate integrity improvements

Further Phase 1 hardening added:

- candidate threshold snapshots
- participant recompute from candidate snapshots
- startup recovery warm-up delay
- cleaner `/vc track` and `/vc config` UX

## Scheduled sessions slice 1

Scheduling support added:

- `scheduled_sessions` table
- `/session schedule`
- `/session upcoming`
- `/session cancel`
- `/session reschedule`
- optional manual scheduled-session linkage during finalize

## Schedule-aware candidate context

Candidate context now includes schedule evidence:

- candidate optional `scheduled_session_id`
- candidate `schedule_match_status`
- conservative time-window matcher
- ambiguity-safe behavior
- schedule context visible in candidate queries

Current rule:

- schedule matches remain evidence only unless an operator links a schedule during finalize

## Admin lock-in draft layer

Lock-in draft support added:

- `session_lockin_drafts`
- `session_lockin_draft_players`
- backend lock-in service
- `/session lockin`
- locked roster display in candidate detail
- finalize defaulting to locked roster when no explicit finalize roster is passed

Current rule:

- lock-in is draft only and does not affect stats until finalize

## Current known gaps

Still not implemented:

- player self-check-in
- public player-facing lock-in flow
- automatic finalize
- `/session live`
- schedule-driven automatic override of candidate game and type
- broad-production hardening for all reconnect and multi-instance edge cases
