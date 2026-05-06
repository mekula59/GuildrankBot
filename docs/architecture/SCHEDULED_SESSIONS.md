# Scheduled Sessions

Scheduled sessions are the planning layer in GuildRank.

They answer:

"What do we expect to happen, and when?"

They do not answer:

"What officially happened?"

That distinction is why planned sessions are useful without being dangerous.

## Why planned sessions exist

Many communities reuse the same voice channels for different games.

For example:

- Monday 17:00 UTC in `Game VC` might mean `codm`
- Friday 17:00 UTC in the same `Game VC` might mean `among_us`

Tracked voice channel defaults are helpful, but they cannot describe every rotating schedule. Planned sessions add that missing intent layer.

## What a planned session stores

A planned session can hold:

- game
- session type
- planned start time
- timezone label
- linked voice channel
- host
- notes

GuildRank stores the real time as a UTC-safe timestamp.

The timezone field is for display and operator context, not the source of truth for conversion.

## Where planned sessions fit in the lifecycle

Planned sessions sit near the start of the game-night flow:

1. planned session
2. community announcement outside GuildRank, if your server uses one
3. detected session from voice activity
4. live session
5. ended live session
6. finalized official event

The planned session tells GuildRank what the night was supposed to be.

The finalized official event tells GuildRank what the night officially became.

## Commands

### `/session schedule`

Creates a planned session.

Use it when the guild knows the expected game, time, and session type ahead of time.

### `/session upcoming`

Lists the planned sessions that are still scheduled.

Use it to check what is coming up.

### `/session cancel`

Cancels a planned session.

Use it when the session is no longer happening.

### `/session reschedule`

Updates a planned session that is still active.

Use it when the start time, game, host, linked voice channel, or notes change.

## How planned sessions connect to detected sessions

When GuildRank opens or closes a detected session, it can try to match it to a planned session.

That match is conservative:

- same guild only
- planned session must still be scheduled
- if a voice channel is linked, it must match
- detected-session start time must land in the allowed window
- ambiguous matches stay unlinked

This is evidence, not official truth.

The match helps an operator understand likely intent, but it does not auto-finalize anything.

## How planned sessions connect to live sessions

`/session start` can begin a live session from a planned session.

This is useful when the operator wants to say:

"The planned game is starting now, and I want to manage the draft roster and result while it happens."

Starting a live session from a planned session still does not affect stats.

## How planned sessions connect to finalized official events

During `/session finalize`, an operator can link the finalized official event to a planned session.

This is the point where the plan and the official result are joined.

The plan itself never moves stats.

The finalized official event does.

## What planned sessions do not mean

A planned session does not mean:

- the game really happened
- everyone in the linked voice channel played
- the final game label must match the original plan
- the final session type must match the original plan
- stats should move automatically

Planned sessions are for context, scheduling, and operator guidance.

## What affects stats and what does not

These do not affect stats by themselves:

- planned sessions
- cancelled planned sessions
- planned-session matches on detected sessions
- live sessions started from planned sessions

This does affect stats:

- finalized official events

## Current limits

Planned sessions are intentionally modest in scope right now:

- they do not auto-create official results
- they do not auto-credit players
- they do not auto-override detected-session context
- they do not provide player check-in yet
- they still rely on operator finalization
