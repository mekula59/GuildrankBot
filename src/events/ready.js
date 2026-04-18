const { recoverOpenSessions } = require('./voiceStateUpdate');
const { recoverSessionCandidateTiming } = require('../utils/sessionCandidates');
const { recalculateAllStats } = require('../jobs/recalcStats');
const logger = require('../utils/logger');
const { withJobLock } = require('../utils/jobLocks');
const { getRuntimeEnvironment } = require('../utils/env');
const { runPendingStatsRepairs } = require('../utils/repairs');
const {
  VC_RECOVERY_LOCK_SECONDS,
  VC_RECOVERY_WARMUP_SECONDS,
  STATS_RECALC_LOCK_SECONDS,
  PENDING_REPAIRS_LOCK_SECONDS,
} = require('../../config/constants');

module.exports = {
  name: 'ready',
  once: true,
  async execute(client) {
    logger.info('discord_ready', {
      bot_user: client.user.tag,
      guild_count: client.guilds.cache.size,
    });
    client.user.setActivity('🏆 Tracking your community', { type: 3 });
    const environmentScope = `${getRuntimeEnvironment()}:global`;

    try {
      if (VC_RECOVERY_WARMUP_SECONDS > 0) {
        await sleep(VC_RECOVERY_WARMUP_SECONDS * 1000);
      }

      await withJobLock(
        { jobType: 'vc_recovery', scopeKey: environmentScope, leaseSeconds: VC_RECOVERY_LOCK_SECONDS, context: { trigger: 'ready_bootstrap' } },
        () => recoverOpenSessions(client)
      );
      await withJobLock(
        { jobType: 'session_candidate_recovery', scopeKey: environmentScope, leaseSeconds: VC_RECOVERY_LOCK_SECONDS, context: { trigger: 'ready_bootstrap' } },
        () => recoverSessionCandidateTiming(client)
      );
      await withJobLock(
        { jobType: 'stats_recalc', scopeKey: environmentScope, leaseSeconds: STATS_RECALC_LOCK_SECONDS, context: { trigger: 'ready_bootstrap' } },
        () => recalculateAllStats({ reason: 'ready_bootstrap' })
      );
      await withJobLock(
        { jobType: 'pending_repairs', scopeKey: environmentScope, leaseSeconds: PENDING_REPAIRS_LOCK_SECONDS, context: { trigger: 'ready_bootstrap' } },
        () => runPendingStatsRepairs(recalculateAllStats)
      );
    } catch (error) {
      logger.error('ready_bootstrap_failed', { error });
    }
  },
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
