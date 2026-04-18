# Operator Guide

## Purpose

This guide is for guild operators running GuildRank in a real community.

It focuses on:

- what commands exist now
- who can run them
- what each workflow actually does
- what changes stats and what does not

## Prerequisites

Before using these commands:

- the bot must be installed in the guild
- `/setup` must have been completed
- the current migration bundle must already be applied

## Permissions

### `/vc` commands

Require `Manage Server`.

Current commands:

- `/vc track`
- `/vc config`
- `/vc list`
- `/vc untrack`

### `/session` commands

Most require `Manage Events`.

Current commands:

- `/session attendance`
- `/session log`
- `/session schedule`
- `/session upcoming`
- `/session cancel`
- `/session reschedule`
- `/session candidates`
- `/session candidate`
- `/session lockin`
- `/session finalize`
- `/session discard`

### `/session correct`

Requires `Manage Server`.

## Stats rules operators should remember

These change stats:

- `/session attendance`
- `/session log`
- `/session finalize`
- passive VC attendance and credited VC minutes

These do **not** change stats by themselves:

- `/vc track`
- `/vc config`
- `/vc untrack`
- `/session schedule`
- `/session upcoming`
- `/session cancel`
- `/session reschedule`
- `/session candidates`
- `/session candidate`
- `/session lockin`
- `/session discard`

## Recommended workflow

## 1. Configure tracked voice defaults

Use `/vc track` for each normal voice room you want GuildRank to observe.

Primary fields:

- `channel`
- `game`
- `session_type`

Use short reusable labels such as:

- `codm`
- `among_us`
- `gartic`
- `general_gaming`
- `mixed`

If you need non-default detection behavior, use `/vc config`.

## 2. Optionally schedule planned sessions

Use:

- `/session schedule`
- `/session upcoming`
- `/session reschedule`
- `/session cancel`

Schedules are planning context only. They do not create official session credit.

## 3. Review VC-assisted candidates

Use:

- `/session candidates`
- `/session candidate`

These views are private and help operators inspect:

- candidate status
- candidate time window
- observed participant rows
- schedule context, if any
- locked roster, if any

### Important interpretation rule

The candidate participant list shows observed people in the VC evidence window.
It is not the same thing as the official player list.

## 4. Save a draft locked roster

Use `/session lockin` on a closed candidate.

You can:

- provide explicit `players`, or
- omit `players` and let GuildRank start from threshold-qualified participant rows

This creates or replaces the draft roster for that candidate.

Lock-in is still not official. It is a reviewed draft.

## 5. Finalize or discard

### Finalize

Use `/session finalize` when the candidate should become an official session.

Current participant selection order:

1. explicit `players` passed to finalize
2. otherwise the saved lock-in draft roster
3. otherwise threshold-qualified candidate participants

You can also pass:

- optional `scheduled_session_id`
- optional `winner`
- optional `mvp`
- optional `notes`

Finalize creates the official event and updates stats.

### Discard

Use `/session discard` when the candidate should not become an official session.

Discard keeps the audit trail but does not create official session credit.

## Manual logging workflow

Use direct manual commands when VC-assisted capture is not the right tool.

### Casual attendance

`/session attendance`

Use when you just need to mark who attended.

### Competitive result logging

`/session log`

Use when you need:

- winner
- MVP
- notes

### Manual correction

`/session correct`

Use when a manual session needs to be voided and stats rebuilt.

## Current command quick reference

### VC defaults

- `/vc track`: save default profile for one VC
- `/vc config`: tune advanced candidate thresholds
- `/vc list`: show saved VC default profiles
- `/vc untrack`: disable tracking for one VC

### Scheduling

- `/session schedule`: create a future planned session
- `/session upcoming`: list currently scheduled sessions
- `/session cancel`: cancel a scheduled session
- `/session reschedule`: update a scheduled session

### VC-assisted review

- `/session candidates`: list candidates
- `/session candidate`: inspect one candidate
- `/session lockin`: create or replace a draft roster
- `/session finalize`: create the official session
- `/session discard`: discard a candidate

### Manual stats workflows

- `/session attendance`
- `/session log`
- `/session correct`

## Current limitations operators should know

- startup recovery is improved but still not fully hardened against every reconnect edge case
- command throttling is not yet truly distributed across multiple bot instances
- schedule matching is evidence only unless an operator links a schedule during finalize
- lock-in is admin-only; there is no player-facing confirmation flow yet
- stage channels are not supported by `/vc track`

## Recommended beta operating mode

For limited monitored beta:

- prefer one app instance
- run staging before production
- actively watch restart and finalize logs
- avoid changing tracked VC thresholds on hot candidates unless necessary
- keep operators aligned on what counts as observed people versus locked players versus finalized official participants
