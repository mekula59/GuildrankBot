# GuildRank System Overview

GuildRank is a reusable Discord product for gaming communities that want trustworthy player records, not noisy guesses from voice chat.

It is built for real guilds where voice channels are not always tidy. A single voice channel might hold active players, spectators, hosts, moderators, and people who are only listening. That means GuildRank has to separate evidence from official truth.

## The truth model

GuildRank is based on a layered truth model.

- VC activity is evidence.
- Detected sessions are evidence.
- Lock-in is draft truth.
- Live sessions are draft operational state.
- Only finalized official events move official stats.

This model is what keeps the system trustworthy across many different communities.

## The main objects in plain English

### Tracked voice channels

Tracked voice channels are the places GuildRank watches.

Each tracked channel stores saved defaults:

- default game label
- default session type
- detection thresholds

These defaults help GuildRank make a good first guess. They are not official truth.

### Planned sessions

Planned sessions are future sessions an operator schedules ahead of time.

They describe expected intent:

- what game is expected
- when it is expected
- what type of session it is
- which voice channel may be used
- who is hosting

A planned session is a plan. It does not prove the session happened.

### VC activity

VC activity is the raw signal GuildRank sees from Discord voice presence.

It answers:

- who was in the channel
- when they joined
- when they left

It does not answer who actually played.

### Detected sessions

Detected sessions are GuildRank's structured guess that a real session may have happened.

Internally these records come from the session-candidate layer, but operators should think of them as detected sessions.

Each detected session carries:

- channel context
- default game and session type context
- start and end window
- observed people
- optional planned session context

Detected sessions are still evidence.

### Observed people

Observed people are the members seen in the detected session window.

GuildRank can track:

- first seen time
- last seen time
- total presence time
- whether the presence threshold was met
- an evidence strength label

Observed people are not the same thing as players.

### Lock-in drafts

Lock-in is the operator-reviewed draft player list for a detected session.

It means:

"Based on the evidence and what I know, these are the real players."

It is draft truth, not official truth.

### Live sessions

Live sessions are the operational draft layer used while a game is happening.

They can start from:

- a detected session
- a planned session
- a tracked voice channel

They can hold:

- players
- spectators
- winner
- MVP
- notes
- real start and end times

Live sessions are still draft state.

### Finalized official events

Finalized official events are the authoritative records that affect stats.

They can come from:

- direct manual logging
- finalized detected sessions
- finalized ended live sessions

This is the only layer that should be treated as official history.

## The full lifecycle

GuildRank is easiest to understand as a lifecycle.

### 1. Plan the night

An operator can schedule a planned session if the community knows what is coming.

This is where the "Friday CODM night" or "Sunday mixed games night" is recorded.

### 2. Announce the night

Many communities announce game nights in Discord before the session starts.

That announcement step is part of the real workflow around GuildRank, even though it is not currently a GuildRank command.

### 3. Detect voice activity

GuildRank watches tracked voice channels and groups meaningful activity into a detected session.

This is where the system says, "Something that looks like a game session happened here."

### 4. Review the evidence

The operator reviews the detected session:

- who was observed
- how long they were present
- whether a planned session matched
- whether the default game and session type look right

### 5. Save draft truth

If needed, the operator uses lock-in to say who actually played.

This is the first strong human review layer, but it is still draft state.

### 6. Run the live session

If the operator wants to manage the game as it happens, they start a live session.

During the live session they can separate:

- players
- spectators
- winner
- MVP
- notes

### 7. End the live session

When the game is over, the live session is ended.

It is still not official until finalized.

### 8. Finalize the result

Finalization creates the finalized official event and moves stats.

This is the step that turns reviewed draft state into official truth.

## Why this model matters

Without these layers, GuildRank would make bad assumptions.

A voice channel alone cannot tell you:

- who played
- who watched
- who joined late
- who should get official credit

The layered model keeps GuildRank reusable across different guild cultures and different room layouts.

## Current command surface

### Voice channel defaults

- `/vc track`
- `/vc config`
- `/vc list`
- `/vc untrack`

### Planned sessions

- `/session schedule`
- `/session upcoming`
- `/session cancel`
- `/session reschedule`

### Detected sessions

- `/session detected_sessions`
- `/session detected_session`
- `/session lockin`
- `/session discard`

### Live sessions

- `/session start`
- `/session update`
- `/session end`
- `/session finalize`

### Direct manual official logging

- `/session attendance`
- `/session log`
- `/session correct`

## What affects stats

These do not affect stats by themselves:

- tracked voice channel defaults
- planned sessions
- VC activity
- detected sessions
- observed people
- lock-in drafts
- live sessions

These do affect stats:

- finalized official events

## Current implementation status

Implemented now:

- tracked voice channel defaults
- VC evidence ingestion
- detected session creation and closing
- observed participant aggregation
- planned sessions
- conservative planned-session matching
- lock-in drafts
- live sessions
- finalize and discard flows
- operator slash commands
- recovery warm-up guardrails

Not implemented now:

- player self-check-in
- public lock-in flow
- automatic finalize
- live-session auto-sync after start
- automatic official credit from schedules alone
- public live session feed
- multi-channel session merging

## Current caveats

GuildRank is usable, but it still benefits from careful operator review.

Important caveats:

- Discord cache state can still matter during reconnect and redeploy recovery.
- Voice evidence can still be noisy in messy community channels.
- Planned session matches are advisory context, not automatic truth.
- Live sessions are intentionally strict so one draft does not become many conflicting drafts.
