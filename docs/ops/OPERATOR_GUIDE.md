# Operator Guide

GuildRank helps operators turn a messy game night into a clean official record.

The short version is simple:

- plan the session if you know it ahead of time
- let GuildRank watch voice activity
- review the detected session
- lock in the real players if needed
- run the live session flow if you want to manage the game while it is happening
- finalize the result when you are sure it is correct

## Read this first

GuildRank is careful on purpose.

Voice activity is evidence.

Detected sessions are evidence.

Lock-in is draft truth.

Live sessions are draft operational state.

Only finalized official events move official stats.

If you remember only one thing, remember that GuildRank does not treat people in voice chat as official players until an operator finalizes the result.

## Who can use what

`/vc` commands require `Manage Server`.

Most `/session` commands require `Manage Events`.

`/session correct` requires `Manage Server` because it voids a manual official event and rebuilds stats.

## Before you start

Before using the session workflows:

- install the bot in the guild
- run `/setup`
- apply the latest database migrations
- redeploy slash commands after command name or option name changes

## Participant reward roles

GuildRank can assign Discord roles after a game night is finalized. This can be a shared participant role, a player-only role, a spectator-only role, or separate roles for players and viewers.

This is intentionally tied to finalization:

- no reward role is assigned from voice activity alone
- no reward role is assigned from player self check-in
- no reward role is assigned when a live session starts or ends
- reward roles are assigned only after `/session finalize` succeeds

This keeps the trust model clear: evidence plus confirmation plus operator approval becomes the official reward.

### `/setup_reward role`

Sets a shared Discord role.

Use this for `players_only`, `spectators_only`, or `players_and_spectators`.

GuildRank checks whether the bot can manage that role before saving it. If setup fails, give the bot `Manage Roles` and move the GuildRank bot role above the reward role.

### `/setup_reward player_role`

Sets the Discord role GuildRank should give finalized players when the scope is `separate_roles`.

### `/setup_reward spectator_role`

Sets the Discord role GuildRank should give finalized spectators when the scope is `separate_roles`.

### `/setup_reward enabled`

Turns participant reward role assignment on or off.

### `/setup_reward scope`

Chooses who can receive the role.

- `players_only` gives the shared reward role to finalized players only.
- `spectators_only` gives the shared reward role to finalized spectators only.
- `players_and_spectators` gives the shared reward role to finalized players and finalized spectators.
- `separate_roles` gives the player reward role to finalized players and the spectator reward role to finalized spectators.

If a needed role is missing or GuildRank cannot manage it, finalization still succeeds. The finalize response shows a warning so an operator can fix the Discord role setup.

### `/setup_reward status`

Shows the current reward role settings, including the shared role, player role, spectator role, enabled state, and scope.

## How a normal game night flows

GuildRank fits a game-night flow that looks like this:

1. Someone plans the session.
2. The community may get an announcement outside GuildRank or through your normal ops process.
3. GuildRank sees voice activity and creates a detected session.
4. An operator reviews who was actually playing.
5. The operator can start a live session if they want to manage the roster and result while the game is active.
6. The live session is ended when the game finishes.
7. The final result is reviewed and turned into a finalized official event.

The announcement step is part of real community operations, but it is not currently a GuildRank command. GuildRank starts with the planned session and continues through detection, draft review, and finalization.

## Voice channel setup

Use `/vc track` once for each voice channel that GuildRank should watch.

The main fields are:

- `channel`
- `game`
- `session_type`

Think of this as saving defaults, not hard rules.

Examples of good game labels:

- `codm`
- `among_us`
- `gartic`
- `general_gaming`
- `mixed`

Use `/vc config` only when a channel needs custom detection thresholds.

Use `/vc list` to review what is tracked.

Use `/vc untrack` to stop watching a voice channel.

## Planned sessions

Planned sessions answer one question:

"What do we expect to happen?"

They do not answer:

"What officially happened?"

### `/session schedule`

Use this when you know a session ahead of time.

Fields:

- `game`
- `session_type`
- `start_time`
- `timezone`
- `voice_channel`
- `host`
- `notes`

### `/session upcoming`

Use this to review upcoming planned sessions.

### `/session cancel`

Use this when the plan is no longer happening.

### `/session reschedule`

Use this when the time, game, host, linked voice channel, or notes change.

Planned sessions do not affect stats by themselves.

## Detected sessions

A detected session is GuildRank saying:

"I saw voice activity that looks like a possible game session."

That is useful, but it is still evidence.

### `/session detected_sessions`

Lists recent detected sessions in the server.

Use it to find the right session by channel, game label, start time, and status.

### `/session detected_session`

Shows details for one detected session.

Use it to review:

- the channel
- the time window
- the observed people
- how long they were present
- whether there is planned session context
- whether a lock-in draft already exists

### `/session lockin`

Creates or replaces a draft player list for a closed detected session.

Use `players` with Discord mentions when you know exactly who played.

If you omit `players`, GuildRank starts from the observed people who met the configured threshold.

Lock-in is draft truth. It is the operator saying, "This is the roster I currently trust."

### `/session discard`

Use this when a detected session should not become an official event.

Typical reasons:

- social voice activity
- a false positive
- a test session
- the wrong group in the wrong channel

Discard does not affect stats.

## Live sessions

Live sessions are for operators who want to manage the real game while it is happening.

They are still draft state until finalized.

### `/session start`

Starts a live session draft.

You can start from:

- `detected_session`
- `planned_session`
- `channel`

Optional fields:

- `game`
- `session_type`
- `notes`

The `game` field is the game label for this live draft. If GuildRank detected the session as the wrong game because the voice channel has a broad default, set `game` when starting the live session.

Use `detected_session` when GuildRank already found the session.

Use `planned_session` when the session was scheduled ahead of time and you want to begin from the plan.

Use `channel` when you want to start directly from a tracked voice channel.

The VC default is only a starting label. If the detected session says the wrong game, update the live session game before finalizing.

### `/session update`

Updates the live draft.

You can replace:

- `players`
- `spectators`
- `game`
- `winner`
- `mvp`
- `notes`

Players and spectators must be different people.

Winner and MVP must be players.

Changing the live session game label does not affect stats by itself. It updates the draft event label that `/session finalize` will use later.

### `/session checkin_open`

Opens player self check-in for a running live session.

GuildRank posts a check-in prompt with three buttons:

- ✅ Playing
- 👀 Spectating
- ❌ Not in this session

When a member clicks a button, GuildRank updates the live draft roster:

- Playing moves them into players.
- Spectating moves them into spectators.
- Not in this session removes them from the live roster but keeps their response for history.

Self check-in is draft input only. It helps reduce operator work, but it does not finalize stats.

### `/session checkin_close`

Closes player self check-in for the running live session.

Use this when the roster is stable or before ending the session.

### `/session checkin_summary`

Shows check-in responses for the live session:

- confirmed players
- confirmed spectators
- not in session
- no response yet, when GuildRank can infer known detected-session participants
- current draft players and spectators

Operators should review this summary before ending and finalizing the session.

### `/session end`

Marks the live session as ended.

This means the game is over, but the result is still draft state until finalized.

### `/session finalize`

Creates the finalized official event from:

- a closed detected session
- an ended live session

This is the only step in the VC-assisted flow that moves official stats.

For detected sessions, GuildRank chooses the player roster in this order:

1. explicit `players` passed to finalize
2. saved lock-in roster
3. threshold-qualified observed people

For live sessions, GuildRank uses the live session player list unless the operator provides an allowed override.

## Manual official logging

Sometimes the VC-assisted flow is not the right tool.

### `/session attendance`

Creates an official casual attendance event directly.

### `/session log`

Creates an official competitive event directly.

Use it when you already know the player list and result.

### `/session correct`

Voids a manual official event and rebuilds stats.

Use it only when the recorded manual result was wrong.

## What changes stats and what does not

These do not change stats by themselves:

- tracked voice channel defaults
- planned sessions
- detected sessions
- observed people
- lock-in drafts
- live sessions
- ended live sessions
- discarded detected sessions
- participant reward role assignment

These do change stats:

- manual official events from `/session attendance`
- manual official events from `/session log`
- finalized official events from `/session finalize`

## Recommended operator workflow

For most communities, this is the safest pattern:

1. Track the main voice channels with `/vc track`.
2. Schedule important nights with `/session schedule`.
3. Let GuildRank create detected sessions from voice activity.
4. Review the detected session.
5. Save a lock-in draft if the observed roster needs cleanup.
6. Start a live session if you want to manage players, spectators, winner, MVP, and notes during the game.
7. Open player self check-in if you want players to confirm their role.
8. End the live session when the game finishes.
9. Finalize the result once the roster and outcome are correct.

## Common mistakes to avoid

- Do not treat everyone in voice chat as an official player automatically.
- Do not assume a planned session means the game really happened.
- Do not assume a detected session is already official.
- Do not forget that lock-in and live sessions are still draft state.
- Do not start a second live session for the same detected session or channel while the first draft still exists.

## Current limits operators should know

- GuildRank does not auto-finalize sessions.
- Lock-in is admin-only.
- Live sessions do not keep auto-syncing with voice occupancy after start.
- Planned session matches are advisory context, not automatic truth.
- Recovery after reconnects still depends partly on Discord cache state.
