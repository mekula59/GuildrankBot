const buckets = new Map();

function now() {
  return Date.now();
}

function sweep(timestamps, windowMs, currentTime) {
  return timestamps.filter(timestamp => currentTime - timestamp < windowMs);
}

function getBucketState(key, windowMs, currentTime, limit = 1) {
  const timestamps = sweep(buckets.get(key) || [], windowMs, currentTime);
  return {
    timestamps,
    allowed: timestamps.length < limit,
    retryAfterMs: timestamps.length < limit
      ? 0
      : Math.max(0, windowMs - (currentTime - timestamps[0])),
  };
}

function formatRetryAfter(retryAfterMs) {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

function checkMutationThrottle({
  commandKey,
  guildId,
  actorId,
  userWindowMs,
  guildWindowMs,
}) {
  const currentTime = now();
  const guildKey = `guild:${commandKey}:${guildId}`;
  const userKey = `user:${commandKey}:${guildId}:${actorId}`;
  const guildResult = getBucketState(guildKey, guildWindowMs, currentTime);
  if (!guildResult.allowed) {
    return {
      allowed: false,
      scope: 'guild',
      retryAfterSeconds: formatRetryAfter(guildResult.retryAfterMs),
    };
  }

  const userResult = getBucketState(userKey, userWindowMs, currentTime);
  if (!userResult.allowed) {
    return {
      allowed: false,
      scope: 'user',
      retryAfterSeconds: formatRetryAfter(userResult.retryAfterMs),
    };
  }

  guildResult.timestamps.push(currentTime);
  userResult.timestamps.push(currentTime);
  buckets.set(guildKey, guildResult.timestamps);
  buckets.set(userKey, userResult.timestamps);

  return { allowed: true, retryAfterSeconds: 0 };
}

module.exports = {
  checkMutationThrottle,
  formatRetryAfter,
  resetThrottleState() {
    buckets.clear();
  },
};
