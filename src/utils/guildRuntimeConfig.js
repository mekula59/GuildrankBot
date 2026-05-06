const DEFAULT_RUNTIME_CONFIG = {
  timezone: null,
  digest_time_utc: null,
  badge_channel_id: null,
  digest_channel_id: null,
  operator_role_ids: [],
  game_catalog_enabled: false,
};

function normalizeOptionalString(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeOperatorRoleIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeOptionalString).filter(Boolean))];
}

function normalizeGuildRuntimeConfig(config = null) {
  if (!config) return null;

  const announceChannelId = normalizeOptionalString(config.announce_channel_id);
  const badgeChannelId = normalizeOptionalString(config.badge_channel_id) || announceChannelId;
  const digestChannelId = normalizeOptionalString(config.digest_channel_id) || announceChannelId;

  return {
    ...config,
    timezone: normalizeOptionalString(config.timezone) || DEFAULT_RUNTIME_CONFIG.timezone,
    digest_time_utc: normalizeOptionalString(config.digest_time_utc) || DEFAULT_RUNTIME_CONFIG.digest_time_utc,
    badge_channel_id: badgeChannelId,
    digest_channel_id: digestChannelId,
    operator_role_ids: normalizeOperatorRoleIds(config.operator_role_ids),
    game_catalog_enabled: config.game_catalog_enabled === true,
  };
}

module.exports = {
  DEFAULT_RUNTIME_CONFIG,
  normalizeGuildRuntimeConfig,
};
