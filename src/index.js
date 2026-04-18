require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const logger = require('./utils/logger');
const supabase = require('./utils/supabase');
const { validateEnvironment, getRuntimeEnvironment } = require('./utils/env');
const { assertRequiredMigrationsApplied } = require('./utils/migrations');
const { withJobLock } = require('./utils/jobLocks');
const { runPendingStatsRepairs } = require('./utils/repairs');
const {
  DAILY_RECALC_CRON,
  PENDING_REPAIR_CRON,
  STATS_RECALC_LOCK_SECONDS,
  PENDING_REPAIRS_LOCK_SECONDS,
} = require('../config/constants');
const { sendWeeklyDigest } = require('./jobs/weeklyDigest');
const { recalculateAllStats } = require('./jobs/recalcStats');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

function loadCommands() {
  client.commands = new Collection();
  fs.readdirSync(path.join(__dirname, 'commands'))
    .filter(file => file.endsWith('.js'))
    .forEach(file => {
      const command = require(`./commands/${file}`);
      if (!command?.data?.name) return;
      client.commands.set(command.data.name, command);
      logger.info('command_loaded', { command: command.data.name, file });
    });
}

function loadEvents() {
  fs.readdirSync(path.join(__dirname, 'events'))
    .filter(file => file.endsWith('.js'))
    .forEach(file => {
      const event = require(`./events/${file}`);
      const handler = (...args) => event.execute(...args, client);
      if (event.once) {
        client.once(event.name, handler);
      } else {
        client.on(event.name, handler);
      }

      logger.info('event_loaded', { event: event.name, file });
    });
}

function scheduleJobs() {
  const environmentScope = `${getRuntimeEnvironment()}:global`;

  cron.schedule(DAILY_RECALC_CRON, async () => {
    try {
      await withJobLock(
        { jobType: 'stats_recalc', scopeKey: environmentScope, leaseSeconds: STATS_RECALC_LOCK_SECONDS, context: { trigger: 'cron' } },
        () => recalculateAllStats({ reason: 'daily_recalc' })
      );
    } catch (error) {
      logger.error('scheduled_recalc_failed', { error });
    }
  });

  cron.schedule('0 20 * * *', async () => {
    try {
      await withJobLock(
        { jobType: 'weekly_digest', scopeKey: environmentScope, leaseSeconds: 3600, context: { trigger: 'cron' } },
        () => sendWeeklyDigest(client)
      );
    } catch (error) {
      logger.error('scheduled_weekly_digest_failed', { error });
    }
  });

  cron.schedule(PENDING_REPAIR_CRON, async () => {
    try {
      await withJobLock(
        { jobType: 'pending_repairs', scopeKey: environmentScope, leaseSeconds: PENDING_REPAIRS_LOCK_SECONDS, context: { trigger: 'cron' } },
        () => runPendingStatsRepairs(recalculateAllStats)
      );
    } catch (error) {
      logger.error('scheduled_pending_repairs_failed', { error });
    }
  });
}

async function bootstrap() {
  validateEnvironment('runtime');
  await assertRequiredMigrationsApplied(supabase);
  logger.info('startup_validated', { migrations_checked: true });
  loadCommands();
  loadEvents();
  scheduleJobs();

  process.on('unhandledRejection', error => {
    logger.error('unhandled_rejection', { error });
  });

  process.on('uncaughtException', error => {
    logger.error('uncaught_exception', { error });
    setTimeout(() => process.exit(1), 100);
  });

  await client.login(process.env.DISCORD_TOKEN);
}

bootstrap().catch(error => {
  logger.error('startup_failed', { error });
  process.exit(1);
});
