# GuildRank System Overview

## Purpose

GuildRank is a reusable multi-community Discord product for gaming groups.
It combines:

- passive VC activity tracking
- manual session logging
- VC-assisted session candidate discovery
- scheduled session planning
- admin-reviewed player lock-in
- finalized official session records

GuildRank is not tied to one community layout. A guild can use fixed game rooms, generic lobby rooms, mixed social/game channels, or rotating schedules on the same VC.

## Core model

GuildRank has several layers of session context. They are not all equal.

### Tracked VC defaults

Tracked voice channels store saved defaults:

- default `game`
- default `session_type`
- advanced candidate thresholds

These defaults help GuildRank infer likely session context, but they are not official truth.

### Scheduled sessions

Scheduled sessions represent planned intent:

- expected game
- expected start time
- expected session type
- optional linked VC
- optional host and notes

Schedules are guild-scoped and stored in UTC-safe form. A schedule does not affect stats by itself.

### Session candidates

A session candidate is an automatically detected possible session in a tracked VC.

It is built from voice presence evidence and includes:

- the tracked VC default profile snapshot
- a time window
- detected member count
- candidate participant rows
- optional matched schedule context

A candidate is evidence, not official truth.

### Candidate participants

Candidate participants are the observed people who were present in the candidate window.

They represent:

- observed people in the VC evidence window
- time spent present in that window
- threshold status
- strength labels such as `strong`, `borderline`, or `weak`

Observed people are not automatically official players. This distinction is important because real VCs often contain spectators, hosts, moderators, listeners, and late joiners.

### Lock-in drafts

Lock-in drafts are the admin-reviewed draft roster for a candidate.

They represent:

- the players an operator currently believes actually played
- optional draft notes
- the operator who locked them in

Lock-in is still draft state. It does not affect stats by itself.

### Finalized official sessions

A finalized official session is the only session-truth layer that should be treated as official for the VC-assisted flow.

Finalize creates:

- an `events` row
- attendance rows
- optional winner and MVP
- optional scheduled session linkage

This is the official truth layer for VC-assisted sessions.

## What affects stats

These sources affect stats:

- passive VC sessions and credited VC minutes
- manual sessions created by `/session attendance`
- manual competitive sessions created by `/session log`
- finalized VC-assisted official sessions created by `/session finalize`

These sources do **not** affect stats by themselves:

- tracked VC defaults
- scheduled sessions
- session candidates
- candidate participants
- schedule auto-match context on candidates
- lock-in drafts

## Current operator workflow

### VC-assisted workflow

1. Use `/vc track` to save a default profile for a voice channel.
2. Optionally tune thresholds with `/vc config`.
3. Let GuildRank observe VC activity and open or close candidates automatically.
4. Review candidates with `/session candidates` and `/session candidate`.
5. Optionally save an admin draft roster with `/session lockin`.
6. Finalize with `/session finalize` or discard with `/session discard`.

### Scheduling workflow

1. Create planned sessions with `/session schedule`.
2. Review them with `/session upcoming`.
3. Change plans with `/session reschedule` or `/session cancel`.
4. During candidate review or finalize, use the schedule context as operator evidence.

### Manual logging workflow

For sessions that should be logged directly:

- `/session attendance`
- `/session log`
- `/session correct`

## Current implementation status

Implemented now:

- tracked VC defaults
- passive VC presence ingestion
- candidate detection and close logic
- candidate participant aggregation
- finalize and discard
- tracked VC operator commands
- scheduled sessions
- schedule-aware candidate context
- admin lock-in drafts
- restart and redeploy recovery with warm-up delay
- repair queue and basic smoke tests

Not implemented now:

- player self-check-in
- public player-facing lock-in flow
- automatic finalize
- `/session live`
- schedule-driven automatic override of candidate game or type
- multi-channel session merging

## Current production caveats

GuildRank is stronger than the original Phase 1 baseline, but it is still not broad-production ready for large public rollout yet.

Current known limitations:

- startup recovery still depends on Discord cache state after a short warm-up, so false closures remain a risk during reconnect or redeploy edge cases
- mutating command throttles are in-memory, so multi-instance throttle behavior is not yet fully enforced across instances
- schedule matching is conservative and evidence-only; it does not automatically become official truth
- lock-in is admin-only and draft-only; there is no player confirmation layer yet
- automated coverage is still light compared with the amount of runtime state involved
