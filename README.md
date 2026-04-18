# GuildRank

Hosted multi-server Discord bot for gaming communities.

GuildRank tracks:
- Passive VC attendance and VC minutes
- Manual session attendance
- Current and longest streaks
- Wins and MVPs from competitive logs
- Leaderboards, stats cards, yearbooks, and weekly digests

## Requirements

- Node.js 18+
- Discord bot application
- Supabase project

## Environment

Copy `.env.example` to `.env` and fill in:

```bash
GUILDRANK_ENV=development
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_DEV_GUILD_ID=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
APP_INSTANCE_ID=
NODE_ENV=production
```

`GUILDRANK_ENV` must be one of `local`, `development`, `staging`, or `production`.

`DISCORD_DEV_GUILD_ID` is only required for guild-scoped command deploys in local, development, and staging.

`APP_INSTANCE_ID` is optional but recommended for multi-instance logs and job locks. If omitted, GuildRank generates one from hostname and pid.

## Discord bot setup

In the Discord developer portal:

1. Create the bot application.
2. Enable `Server Members Intent`.
3. Keep slash commands enabled.
4. Invite the bot with these permissions:
   - `View Channels`
   - `Send Messages`
   - `Embed Links`
   - `Read Message History`
   - `Use Application Commands`

`Message Content Intent` is not required.

## Supabase setup

1. Create a Supabase project.
2. Run:

```bash
npm install
npm run setup-db
```

3. Paste the printed SQL into the Supabase SQL editor and run it.

`npm run setup-db` now prints the ordered migration bundle from `migrations/*.sql`.

Apply every migration to staging first, then production.

## Command deployment

For development:

```bash
npm run deploy:guild
```

This deploys commands only to `DISCORD_DEV_GUILD_ID` and updates almost immediately.

Guild-scoped deploys are blocked when `GUILDRANK_ENV=production`.

For production:

```bash
npm run deploy:global
```

Global Discord deploys can take up to an hour to appear everywhere.

Global deploys are blocked unless `GUILDRANK_ENV=production`.

## Run the bot

```bash
npm start
```

On startup the bot:
- validates required environment variables
- validates the required migration versions are already applied
- recovers any open VC sessions left over from restarts
- resumes still-active voice sessions
- rebuilds `player_stats` from source tables so stale streaks and old data drift are corrected

## Core commands

| Command | Purpose |
| --- | --- |
| `/setup` | Configure announcement channel, community type, and digest day |
| `/leaderboard` | Rank by sessions, streak, or VC time |
| `/stats` | View one player profile |
| `/session attendance` | Credit a casual session to all mentioned players |
| `/session log` | Credit a competitive session to all mentioned players, with optional winner and MVP |
| `/session correct` | Void a manual session by exact event ID, record the correction, and rebuild stats |
| `/yearbook` | Show community highlights |

## Stats model

`player_stats` is the single runtime stats model.

It now combines:
- `total_events`: all credited sessions, whether passive VC or manual logs
- `total_vc_sessions`
- `total_manual_sessions`
- `total_vc_minutes`
- `wins`
- `mvps`
- `current_streak`
- `longest_streak`

Manual session rules:
- `/session attendance` gives every mentioned player one credited session.
- `/session log` gives every mentioned player one credited session.
- If a winner or MVP is supplied but not included in the mention list, GuildRank auto-includes them and credits the session as well.
- Manual session writes are idempotent by Discord interaction ID, so retries do not double-credit players.

VC anti-farming rules:
- VC time only counts if the member shared a non-AFK voice channel with at least one other human during that session.
- Credited VC time is capped per session to reduce idle leaderboard farming.

Phase 1 production guardrails now in place:
- versioned SQL migrations in `migrations/`
- startup migration verification
- job locks for daily stat rebuilds and weekly digests
- weekly digest dedupe history
- audit logs for manual attendance and competitive session logging
- append-only admin corrections ledger and helper
- structured JSON logs with request IDs, guild IDs, and job contexts

Phase 1.5 additions:
- startup VC recovery lock across multi-instance boot
- mutating command cooldowns for `/setup`, `/session attendance`, `/session log`, and `/session correct`
- audit logging for setup/config changes and guild deactivation
- safe operator correction workflow via `/session correct`
- queued stat repairs when source writes succeed but rebuilds fail
- minimal automated smoke tests in `tests/`

## Notes

- The bot uses the Supabase service role key on the server side only. Never commit it.
- `player_stats` is rebuilt from `vc_sessions`, `events`, and `event_attendance`, so those source tables should not be edited casually in production.
- Use separate Discord applications, bot tokens, and Supabase projects for staging and production.

## Tests

Run the local smoke checks with:

```bash
npm test
```

For the staging checklist, use [tests/SMOKE_TEST_PLAN.md](/Users/mekula/Desktop/guildrank-hosted%20/tests/SMOKE_TEST_PLAN.md).
