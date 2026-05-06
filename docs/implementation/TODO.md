# GuildRank TODO

This file tracks the most important remaining work in grouped product and rollout buckets.

## Release blockers before broader production

- Reduce remaining recovery dependence on cold Discord cache state after reconnect or redeploy.
- Replace or supplement in-memory mutation throttling with a cross-instance-safe approach.
- Add stronger integration coverage for finalize, discard, live-session transitions, repair recovery, and restart behavior.
- Expand multi-instance safety checks around jobs, command handling, and recovery timing.

## Next staging tasks

- Re-run staging flows that cover planned session, detected session, live session, ended session, and finalized result as one continuous operator journey.
- Re-test duplicate live-session start failures for both channel conflict and detected-session linkage conflict.
- Re-test restart and redeploy behavior while detected sessions and live sessions already exist.
- Verify operator messaging stays clear for finalize, discard, duplicate starts, and schedule linkage edge cases.

## Product improvements

- Add a dedicated read-only view for current live sessions so operators can inspect draft state without updating it.
- Add a safe player-facing confirmation layer without letting self-reporting become official truth automatically.
- Improve planned-session review during finalize without turning schedule context into automatic truth.
- Improve operator visibility into which roster source was used during finalization.
- Add clearer history views for discarded detected sessions, lock-in changes, and live-session updates.

## Documentation and training

- Keep operator docs aligned with every slash-command rename or workflow change.
- Add a compact staging checklist that mirrors the real game-night flow from planned session through finalized official event.
- Keep examples grounded in reusable community patterns such as shared lobbies, mixed gaming channels, and rotating game nights.

## Rollout decisions

- Decide what minimum monitoring must be in place before a broader production rollout.
- Decide whether a future reopen or clone flow for ended live sessions is desirable, or whether one detected session should always map to one live draft.
- Decide how much operator training is needed before non-technical staff use live-session workflows at scale.

## Explicitly not implemented yet

- player self-check-in
- public lock-in workflow
- automatic finalize
- automatic official credit from VC occupancy alone
- automatic official credit from planned sessions alone
- stage-channel tracking as a normal `/vc track` path
