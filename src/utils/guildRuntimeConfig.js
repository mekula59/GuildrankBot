const DEFAULT_RUNTIME_CONFIG = {
  timezone: null,
  digest_time_utc: null,
  badge_channel_id: null,
  digest_channel_id: null,
  operator_role_ids: [],
  game_catalog_enabled: false,
  participant_reward_role_id: null,
  player_reward_role_id: null,
  spectator_reward_role_id: null,
  participant_reward_enabled: false,
  participant_reward_scope: 'players_only',
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

function normalizeParticipantRewardScope(value) {
  const allowed = new Set([
    'players_only',
    'spectators_only',
    'players_and_spectators',
    'separate_roles',
  ]);
  return allowed.has(value) ? value : 'players_only';
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
    participant_reward_role_id: normalizeOptionalString(config.participant_reward_role_id),
    player_reward_role_id: normalizeOptionalString(config.player_reward_role_id),
    spectator_reward_role_id: normalizeOptionalString(config.spectator_reward_role_id),
    participant_reward_enabled: config.participant_reward_enabled === true,
    participant_reward_scope: normalizeParticipantRewardScope(config.participant_reward_scope),
  };
}

module.exports = {
  DEFAULT_RUNTIME_CONFIG,
  normalizeGuildRuntimeConfig,
  normalizeParticipantRewardScope,
};
