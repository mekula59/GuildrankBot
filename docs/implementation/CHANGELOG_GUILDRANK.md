# GuildRank Changelog

This changelog is a practical record of what the current GuildRank repo implements. It is written as a product and operations log, not a raw commit dump.

## Current product shape

GuildRank currently supports:

- tracked voice channel defaults
- VC activity ingestion
- detected sessions from voice activity
- observed participant aggregation
- manual session logging
- planned sessions
- lock-in drafts
- live sessions
- finalize and discard flows
- audit and repair guardrails

## Implementation timeline

### 1. Base product foundation

The first layer established GuildRank as a multi-guild Discord product with the basic data and command surface needed for attendance and stats.

Key outcomes:

- core player, event, attendance, and stat tables
- manual session logging
- passive VC attendance tracking
- leaderboard and digest foundations

### 2. Operational guardrails and correction paths

The next layer focused on making operator actions safer and easier to recover.

Key outcomes:

- versioned SQL migrations
- startup migration checks
- audit logging for operator actions
- manual correction workflow
- queued stat repairs when rebuilds fail
- mutation throttles
- recurring job locks

### 3. VC-assisted capture foundation

This slice added the first real evidence-based session flow.

Key outcomes:

- tracked voice channel configuration
- VC presence segment ingestion
- detected-session creation
- detected-session closing logic
- observed participant aggregation
- finalize and discard from detected sessions

### 4. Detected-session integrity hardening

After the first VC-assisted flow existed, the next work focused on making it safer to trust.

Key outcomes:

- threshold snapshot fields stored on detected sessions
- participant recompute tied to detected-session snapshots, not mutable channel config
- restart and redeploy recovery warm-up delay
- cleaner tracked-channel setup UX

### 5. Planned sessions

This slice introduced the planning layer.

Key outcomes:

- `scheduled_sessions` schema
- `/session schedule`
- `/session upcoming`
- `/session cancel`
- `/session reschedule`
- optional planned-session linkage during finalize

### 6. Planned-session context on detected sessions

The next step connected planning with VC evidence without turning plans into automatic truth.

Key outcomes:

- optional planned-session linkage on detected sessions
- conservative planned-session matcher
- ambiguity-safe behavior
- planned-session context visible during detected-session review

Important rule:

planned-session matches remain evidence only unless an operator finalizes an official result.

### 7. Lock-in drafts

This slice added the draft-truth layer between evidence and official results.

Key outcomes:

- lock-in draft tables
- backend lock-in service
- `/session lockin`
- locked roster shown during detected-session review
- finalize defaulting to the saved lock-in roster when no explicit roster is passed

Important rule:

lock-in is draft truth. It does not move stats by itself.

### 8. Live sessions

This slice added the operational draft layer used while a game is happening.

Key outcomes:

- `live_sessions`
- `live_session_people`
- player and spectator separation
- `/session start`
- `/session update`
- `/session end`
- `/session finalize` support for ended live sessions
- event source support for live-session finalization

Important rule:

live sessions are draft operational state. Only finalization creates the official event.

### 9. Operator UX cleanup

After the core live-session path existed, the focus shifted to operator usability.

Key outcomes:

- human-readable detected-session labels in autocomplete and command output
- mention-driven player, winner, and MVP input
- clearer `/session start` source labels
- operator-facing rename from internal candidate language to detected-session language
- clearer duplicate-start failures for live-session starts
- live-session participant self check-in as draft roster input

## Current known limits

These areas are still intentionally unfinished:

- no public lock-in flow
- no automatic finalize
- no live-session auto-sync after start
- no automatic official credit from planned sessions alone
- no broad-production hardening for every reconnect and multi-instance edge case
