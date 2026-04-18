# GuildRank TODO

This file lists practical next steps based on the current implementation.

## Before broader production

- Harden startup recovery so live sessions and candidates are less dependent on cold Discord caches after reconnect or redeploy.
- Replace or supplement in-memory command throttling with a cross-instance-safe throttle path.
- Add more DB-backed integration coverage for candidate close, lock-in, finalize, discard, schedule linkage, and repair queue behavior.
- Expand staging verification around restart timing, repair recovery, and multi-instance behavior.

## Next product slices

- Add `/session live` so operators can inspect live session state without waiting for close and finalize.
- Add a safe player-facing confirmation layer without letting self-reporting become official truth automatically.
- Improve schedule-aware operator workflows without turning schedule matches into automatic official truth.

## Current workflow improvements

- Improve operator visibility around which finalize roster source was used across more admin views.
- Add better audit-friendly views for schedule context, lock-in history, and discarded candidates.
- Consider a clearer operator command for unlinking or replacing schedule context during finalize-time review.

## Reuse and multi-community support

- Keep documenting reusable game label guidance for mixed communities.
- Expand guidance for communities that rotate multiple games through one shared VC.
- Decide whether future multi-channel session support is necessary for faction or team comms.

## Explicitly not implemented yet

- public player self-check-in
- public lock-in workflow
- automatic finalize
- automatic official credit from VC occupancy alone
- automatic official credit from schedules alone
- stage-channel tracking as a normal `/vc track` path

## Ongoing documentation work

- Keep the operator guide aligned with the slash-command surface after every session-system change.
- Keep the staging test plan aligned with new migration slices and recovery behavior.
- Update this TODO whenever a roadmap item becomes implemented or is intentionally dropped.
