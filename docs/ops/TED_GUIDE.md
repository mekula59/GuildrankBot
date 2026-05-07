# Ted Guide

This guide explains the game-night flow in plain language.

GuildRank is meant to help a mod or operator turn messy voice activity into a clean official record.

## The truth model

Voice activity is evidence.

Detected sessions are evidence.

Player check-in and lock-in are draft truth.

Live sessions are draft operational state.

Only finalized official events affect stats and rewards.

## Game labels

A tracked voice channel has a default game label. That label is only a starting point.

For example, a broad game VC might default to `chess`, but tonight the actual session might be `codm`.

If the detected session says the wrong game, update the live session game before finalizing.

Use:

- `/session start detected_session game:<game>` when starting from voice activity
- `/session start planned_session game:<game>` when starting from a planned session
- `/session start channel game:<game>` when starting directly from a tracked voice channel
- `/session update live_session game:<game>` when the live draft already exists

Changing the game label on a live session does not move stats.

The corrected game label becomes official only when an operator runs `/session finalize`.

## Simple game-night flow

1. Start from a detected session, planned session, or tracked channel.
2. Confirm who is playing and who is spectating.
3. Correct the game label if the default is wrong.
4. End the live session when the game is over.
5. Finalize only when the roster, game label, winner, MVP, and notes look right.
