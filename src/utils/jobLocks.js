const supabase = require('./supabase');
const logger = require('./logger');
const { getInstanceId } = require('./env');

async function acquireJobLock(jobType, scopeKey, leaseSeconds = 900) {
  const ownerId = getInstanceId();
  const { data, error } = await supabase.rpc('acquire_job_lock', {
    p_job_type: jobType,
    p_scope_key: scopeKey,
    p_owner_id: ownerId,
    p_lease_seconds: leaseSeconds,
  });

  if (error) throw error;
  return { acquired: Boolean(data), ownerId };
}

async function releaseJobLock(jobType, scopeKey, ownerId, status, errorMessage = null) {
  const { error } = await supabase.rpc('release_job_lock', {
    p_job_type: jobType,
    p_scope_key: scopeKey,
    p_owner_id: ownerId,
    p_status: status,
    p_error_message: errorMessage,
  });

  if (error) throw error;
}

async function withJobLock({ jobType, scopeKey = 'global', leaseSeconds = 900, context = {} }, work) {
  const { acquired, ownerId } = await acquireJobLock(jobType, scopeKey, leaseSeconds);

  if (!acquired) {
    logger.info('job_lock_skipped', { job_type: jobType, scope_key: scopeKey, ...context });
    return { skipped: true };
  }

  logger.info('job_lock_acquired', { job_type: jobType, scope_key: scopeKey, owner_id: ownerId, ...context });

  try {
    const result = await work({ ownerId });
    await releaseJobLock(jobType, scopeKey, ownerId, 'completed');
    logger.info('job_lock_released', { job_type: jobType, scope_key: scopeKey, owner_id: ownerId, status: 'completed', ...context });
    return { skipped: false, result };
  } catch (error) {
    try {
      await releaseJobLock(jobType, scopeKey, ownerId, 'failed', error.message || 'unknown_error');
    } catch (releaseError) {
      logger.error('job_lock_release_failed', {
        job_type: jobType,
        scope_key: scopeKey,
        owner_id: ownerId,
        error: releaseError,
      });
    }

    logger.error('job_lock_failed', {
      job_type: jobType,
      scope_key: scopeKey,
      owner_id: ownerId,
      error,
      ...context,
    });
    throw error;
  }
}

module.exports = {
  acquireJobLock,
  releaseJobLock,
  withJobLock,
};
