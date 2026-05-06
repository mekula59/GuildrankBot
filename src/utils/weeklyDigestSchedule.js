const { normalizeGuildRuntimeConfig } = require('./guildRuntimeConfig');

// Legacy behavior only runs for setup's original digest-day choices.
const LEGACY_DAY_MAP = { 0: 'sunday', 1: 'monday', 5: 'friday', 6: 'saturday' };
const DEFAULT_DIGEST_TIME_UTC = '20:00';

function getUtcTimeString(now = new Date()) {
  return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
}

function getConfiguredDayName(config, now = new Date()) {
  if (!config?.timezone) {
    return LEGACY_DAY_MAP[now.getDay()] || null;
  }

  try {
    const weekday = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: config.timezone,
    }).format(now);
    return String(weekday || '').toLowerCase();
  } catch {
    return LEGACY_DAY_MAP[now.getDay()] || null;
  }
}

function shouldSendDigestForConfig(config, now = new Date()) {
  const runtimeConfig = normalizeGuildRuntimeConfig(config);
  if (!runtimeConfig?.digest_day) return false;

  const configuredTime = runtimeConfig.digest_time_utc || DEFAULT_DIGEST_TIME_UTC;
  if (configuredTime !== getUtcTimeString(now)) {
    return false;
  }

  const todayName = getConfiguredDayName(runtimeConfig, now);
  return Boolean(todayName && runtimeConfig.digest_day === todayName);
}

module.exports = {
  DEFAULT_DIGEST_TIME_UTC,
  getConfiguredDayName,
  getUtcTimeString,
  shouldSendDigestForConfig,
};
