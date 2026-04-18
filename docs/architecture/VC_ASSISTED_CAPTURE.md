# VC-Assisted Capture

## Goal

VC-assisted capture helps operators turn messy real-world voice activity into trustworthy official session records without assuming that everyone in VC was an actual player.

The current model is:

- tracked VC defaults give fallback context
- observed VC activity creates candidates
- candidate participants represent observed people
- admin lock-in drafts represent intended actual players
- finalize creates official participants

## Why observed people are not auto-counted

A VC can contain:

- active players
- spectators
- hosts or moderators
- substitutes
- late joiners
- people just listening

Because of that, GuildRank does not treat candidate participants as official players automatically.

## Current lifecycle

### 1. Track a VC

Operators save a default profile with `/vc track`:

- `channel`
- `game`
- `session_type`

Advanced thresholds can be tuned later with `/vc config`.

### 2. Ingest presence evidence

GuildRank records voice presence segments for members in tracked channels.

Candidate opening uses:

- minimum active human members
- minimum candidate duration

Candidate closing uses:

- grace gap seconds below threshold

### 3. Open a candidate

When the configured threshold holds long enough, GuildRank opens a `session_candidate`.

At candidate creation time it snapshots:

- default game
- default session type
- minimum active members
- minimum candidate duration
- minimum participant presence minutes
- grace gap seconds

Those snapshots protect the candidate from later config drift.

### 4. Close and aggregate participants

When activity falls below threshold long enough, the candidate closes.

GuildRank then computes `candidate_participants` using:

- candidate window start and end
- merged presence intervals
- grace-gap-aware interval merging
- minimum participant presence threshold

Each candidate participant row stores:

- first and last seen timestamps inside the candidate window
- total presence seconds
- threshold result
- strength label

Current strength labels:

- `strong`
- `borderline`
- `weak`

### 5. Attach schedule context when possible

When a candidate opens or closes, GuildRank tries to attach a matching scheduled session.

Current matching rules:

- same guild only
- scheduled session status must be `scheduled`
- if the schedule has a linked VC, it must match the candidate channel
- candidate start time must fall within the schedule window
- if more than one schedule matches, GuildRank does not auto-link one

Current time window:

- up to 45 minutes before scheduled start
- up to 90 minutes after scheduled start

This schedule link is evidence only.

### 6. Admin lock-in draft

Operators can save a draft roster with `/session lockin`.

Current rules:

- candidate must be `closed`
- candidate participant snapshot must be ready
- roster must be a subset of the candidate participant pool
- re-running `/session lockin` replaces the existing draft for that candidate

If `players` is omitted, lock-in defaults to the threshold-qualified candidate participants.

Lock-in is still not official truth. It is only a reviewed draft.

### 7. Finalize or discard

Operators then choose:

- `/session finalize`
- `/session discard`

Finalize creates the official session record.

Discard closes the workflow without creating an official session.

## Observed vs locked vs finalized

### Observed people

Observed people come from `candidate_participants`.

They answer:

- who was seen in the voice evidence window
- how long they were present

They do not answer:

- who actually played
- who should receive official session credit

### Locked players

Locked players come from `session_lockin_drafts` and `session_lockin_draft_players`.

They answer:

- which observed people an admin currently believes actually played

They still do not affect stats by themselves.

### Finalized official participants

Finalized official participants come from the created `events` row plus `event_attendance`.

They answer:

- who officially participated
- which session counts toward official stats

## Finalize roster selection

Current finalize behavior chooses participants in this order:

1. explicit `players` passed to `/session finalize`
2. otherwise the saved lock-in draft roster
3. otherwise threshold-qualified candidate participants

All finalize participant lists must still be a subset of the candidate pool.

## Operator command surface

### VC commands

- `/vc track`
- `/vc config`
- `/vc list`
- `/vc untrack`

These require `Manage Server`.

### Session commands for VC-assisted capture

- `/session candidates`
- `/session candidate`
- `/session lockin`
- `/session finalize`
- `/session discard`

These require `Manage Events` except `/session correct`, which uses `Manage Server`.

Candidate, schedule, lock-in, finalize, and discard paths reply privately.

## Recovery behavior

On startup, GuildRank:

- waits for a short warm-up delay
- acquires distributed job locks
- recovers open VC sessions
- recovers candidate timing

The warm-up reduces false closures from cold caches, but recovery still depends on Discord cache state and is not yet fully hardened for every reconnect edge case.

## What changes stats

VC-assisted objects that do not change stats by themselves:

- tracked VC defaults
- voice presence segments
- session candidates
- candidate participants
- schedule context on candidates
- lock-in drafts

VC-assisted objects that change stats:

- finalized official events
- their attendance rows

## Current limitations

- no player-facing confirmation flow
- no automatic finalize
- no `/session live` operator view yet
- no schedule-driven automatic override of candidate game or type
- schedule context is still advisory unless the operator links it during finalize
- broad-production hardening is still incomplete
