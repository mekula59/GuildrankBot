# VC-Assisted Capture

VC-assisted capture is the part of GuildRank that turns voice activity into something an operator can review and eventually finalize.

Its job is not to guess final truth perfectly.

Its job is to gather useful evidence, shape it into detected sessions, and give operators a safe review path before stats move.

## The core rule

Voice activity is evidence, not official truth.

That rule exists because real voice channels are messy.

A voice channel may contain:

- active players
- spectators
- hosts
- moderators
- late joiners
- people who are only listening

If GuildRank treated everyone in voice as an official player automatically, the records would drift away from reality very quickly.

## What VC-assisted capture actually does

VC-assisted capture moves through these steps:

1. Track the right voice channels.
2. Watch who joins and leaves.
3. Open a detected session when activity looks real enough.
4. Close the detected session when activity drops off.
5. Aggregate the observed people.
6. Optionally match the detected session to a planned session.
7. Let an operator review, lock in, run a live session, finalize, or discard.

## Step 1: tracked voice channels

Operators decide which voice channels GuildRank should watch.

`/vc track` stores the default session profile for a channel:

- `channel`
- `game`
- `session_type`

These are defaults, not hard rules.

Advanced threshold tuning lives behind `/vc config`.

## Step 2: watch voice activity

GuildRank ingests voice presence as members join and leave tracked channels.

This gives the system a timeline of who was present and for how long.

At this stage, GuildRank still knows nothing about who actually played.

## Step 3: open a detected session

When enough human members stay active for long enough, GuildRank opens a detected session.

At creation time it snapshots the settings that mattered for that detection:

- default game
- default session type
- minimum active member threshold
- minimum detected-session duration
- minimum participant presence threshold
- grace-gap timing

The snapshot matters because operators may later change channel config. Old detected sessions should still be judged by the settings they were created under.

## Step 4: close the detected session

When activity falls below the threshold long enough, GuildRank closes the detected session.

This creates a clear window that can be reviewed.

The detected session says:

"Here is the time period where this voice activity looked like a real session."

## Step 5: aggregate observed people

After close, GuildRank computes the observed people for that window.

For each observed person, GuildRank can store:

- first seen time
- last seen time
- total presence time
- whether they met the configured threshold
- evidence strength

Observed people are the evidence pool. They are not yet the official player list.

## Step 6: attach planned session context when possible

GuildRank can try to link a detected session to a planned session.

This match is conservative by design:

- same guild only
- the planned session must still be scheduled
- if the plan has a linked voice channel, it must match
- the detected session start time must fit the allowed window
- if more than one plan matches, GuildRank does not auto-link one

This match helps an operator understand likely intent.

It does not make the detected session official.

## Step 7: operator review paths

Once a detected session exists, operators have several paths.

### Review the detected session

`/session detected_sessions` lists recent detected sessions.

`/session detected_session` shows details for one detected session, including observed people and any planned-session context.

### Save lock-in draft truth

`/session lockin` lets the operator save the player list they currently trust.

This is draft truth. It is stronger than raw evidence, but it still does not affect stats.

### Start a live session

`/session start detected_session` lets the operator promote the detected session into a live operational draft.

This is useful when the game is still happening and the operator wants to actively manage:

- players
- spectators
- winner
- MVP
- notes

### Finalize

`/session finalize` turns a reviewed detected session or ended live session into a finalized official event.

This is the moment stats move.

### Discard

`/session discard` closes the review path without creating an official event.

This is the right choice when the evidence looked like a session but should not count officially.

## Why players and spectators stay separate

This separation is one of the most important design choices in GuildRank.

Detected sessions tell us who was around.

They do not tell us who was actually playing.

Live sessions and lock-in drafts let operators separate:

- players
- spectators

That makes the final official record much more trustworthy.

## What affects stats and what does not

These do not affect stats by themselves:

- tracked voice channel defaults
- raw VC activity
- detected sessions
- observed people
- planned-session matches
- lock-in drafts
- live sessions

This does affect stats:

- finalized official events

## Important safeguards

GuildRank keeps several integrity rules around VC-assisted capture:

- a detected session is evidence, not truth
- a live session must be reviewed before finalization
- players and spectators must stay separate in live-session drafts
- one detected session should not branch into multiple conflicting live drafts
- one live session should not run twice for the same channel at the same time

These rules are intentional. They prevent duplicate or contradictory official records.

## Current limits

VC-assisted capture is strong enough for staged use, but it still has limits:

- no player self-check-in yet
- no automatic finalize
- no live-session auto-sync after start
- planned-session matches stay advisory
- reconnect recovery still depends partly on Discord cache state
