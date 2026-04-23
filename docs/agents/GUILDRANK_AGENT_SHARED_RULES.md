# GuildRank Agent Shared Rules

These rules apply to every GuildRank standby agent. They are the default operating contract for build, debug, QA, release, documentation, guild operations, and governance work.

GuildRank is a reusable multi-community product. Olympus Prime is the first flagship deployment, not the product definition. Agents must not hardcode one guild, community, channel layout, game, operator, deployment name, or event format into schema, services, commands, docs, tests, defaults, or rollout guidance.

## Shared Product Rules

- Preserve guild isolation on every read, write, query, command, audit record, and report.
- Treat Discord voice activity as evidence, not official truth.
- Treat VC candidate participants as evidence, not official truth.
- Treat admin lock-in as draft truth, not official stats.
- Treat live sessions as draft operational state, not official stats.
- Treat only finalized official events as stats-moving truth.
- Keep operator workflows human-readable and practical for real gaming guilds.
- Prefer reversible draft states before irreversible official writes.
- Keep GuildRank reusable across fixed game VCs, generic lobby VCs, mixed social/game VCs, faction/team comms, and rotating scheduled sessions.
- Do not assume every VC occupant is a player.
- Do not assume every player stayed in VC for the whole session.
- Do not assume every spectator, host, moderator, or late joiner should count.

## Privacy And Secret Handling

- Never reveal, print, copy, summarize, or commit secrets.
- Never expose `.env` values, API keys, bot tokens, Supabase service-role keys, JWT secrets, webhook secrets, OAuth secrets, database URLs, private deployment URLs, or private operator data.
- Never recommend committing `.env` files or secrets to Git.
- If a command output contains secrets, redact the value and report only the safe finding.
- If a log contains sensitive guild, operator, user, or private channel data, summarize behavior without exposing unnecessary identifiers.
- Use placeholder examples such as `<guild_id>`, `<discord_user_id>`, `<token>`, or `<private_url>`.
- Do not move secrets between environments unless explicitly instructed by an authorized operator using a secure process.
- Do not create new secret storage patterns without governance review.

## Trust Model Rules

The product truth ladder is:

1. Tracked VC defaults: saved defaults for a channel.
2. Scheduled sessions: expected intent.
3. VC evidence: observed presence and candidate pools.
4. Lock-in drafts: admin-selected draft player roster.
5. Live sessions: draft operational state while a session is happening.
6. Finalized official events: official truth and the only stats-moving layer.

Agents must preserve this separation in code, tests, docs, release notes, and operator guidance.

## Debugging Discipline

- Reproduce or inspect before changing code.
- Identify the exact failure point before fixing.
- Prefer the smallest targeted fix that preserves current product behavior.
- Do not broad-refactor while debugging a staging or production issue.
- Add temporary diagnostics only when they are precise, privacy-safe, and removable.
- Never log secrets or raw environment values.
- Verify fixes with syntax checks, tests, or a staging retest plan.
- State what was verified and what was not verified.

## Governance And Drift Control

- Any change that alters stats movement, roster truth, guild isolation, permissions, schema authority, or public site visibility needs governance review.
- Any change that makes automation more authoritative than human finalize needs governance review.
- Any community-specific default or assumption needs governance review.
- Any new command that affects official state needs release-gate review.
- Any live or scheduled session behavior that could be mistaken for official stats must be documented clearly.

## Suggested Skill Use

Agents may use gstack skills when useful, but shared GuildRank rules override generic skill output.

- Use `investigate` for runtime bugs, staging failures, and root-cause work.
- Use `qa` or `qa-only` for staged product-flow testing.
- Use `review` for pre-release code review.
- Use `health` for broader test/lint/build checks.
- Use `document-release` for doc and changelog sync.
- Use `canary` for post-deploy monitoring where available.
- Use `cso` for security and secret-handling review.

Suggested skills are helpers, not authority. Agents must still protect secrets, preserve guild isolation, and maintain GuildRank's trust model.
