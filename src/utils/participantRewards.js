const { PermissionFlagsBits } = require('discord.js');
const logger = require('./logger');

const EMPTY_REWARD_SUMMARY = {
  enabled: false,
  roleId: null,
  playerRoleId: null,
  spectatorRoleId: null,
  scope: 'players_only',
  assigned: 0,
  skipped: 0,
  failed: 0,
  reason: 'disabled',
  warnings: [],
};

function uniqueIds(ids = []) {
  return [...new Set((ids || []).filter(Boolean))];
}

function getSpectatorIds(people = []) {
  return uniqueIds((people || [])
    .filter(row => row?.roster_role === 'spectator')
    .map(row => row.discord_user_id));
}

function buildRewardParticipantIds({ participantIds = [], people = [], scope = 'players_only' } = {}) {
  const playerIds = uniqueIds(participantIds);
  const spectatorIds = getSpectatorIds(people);

  if (scope === 'spectators_only') {
    return spectatorIds;
  }

  if (scope === 'players_and_spectators') {
    return uniqueIds([...playerIds, ...spectatorIds]);
  }

  if (scope === 'separate_roles') {
    return uniqueIds([...playerIds, ...spectatorIds]);
  }

  return playerIds;
}

function buildRewardBuckets({ participantIds = [], people = [], config = {} } = {}) {
  const scope = config?.participant_reward_scope || 'players_only';
  const sharedRoleId = config?.participant_reward_role_id || null;
  const playerRoleId = config?.player_reward_role_id || null;
  const spectatorRoleId = config?.spectator_reward_role_id || null;
  const playerIds = uniqueIds(participantIds);
  const spectatorIds = getSpectatorIds(people);

  if (scope === 'separate_roles') {
    return [
      { label: 'players', roleId: playerRoleId, userIds: playerIds },
      { label: 'spectators', roleId: spectatorRoleId, userIds: spectatorIds },
    ];
  }

  if (scope === 'spectators_only') {
    return [{ label: 'spectators', roleId: sharedRoleId, userIds: spectatorIds }];
  }

  if (scope === 'players_and_spectators') {
    return [{ label: 'players and spectators', roleId: sharedRoleId, userIds: uniqueIds([...playerIds, ...spectatorIds]) }];
  }

  return [{ label: 'players', roleId: sharedRoleId, userIds: playerIds }];
}

function hasRewardRolePermission(botMember, role) {
  if (!botMember || !role) return false;
  if (!botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) return false;
  return botMember.roles.highest.comparePositionTo(role) > 0;
}

async function assignParticipantRewardRoles({
  guild,
  guildId,
  config,
  participantIds,
  people = [],
  source = 'session_finalize',
}) {
  const enabled = config?.participant_reward_enabled === true;
  const scope = config?.participant_reward_scope || 'players_only';
  const roleId = config?.participant_reward_role_id || null;
  const playerRoleId = config?.player_reward_role_id || null;
  const spectatorRoleId = config?.spectator_reward_role_id || null;

  if (!enabled) {
    return {
      ...EMPTY_REWARD_SUMMARY,
      enabled,
      roleId,
      playerRoleId,
      spectatorRoleId,
      scope,
      reason: 'disabled',
    };
  }

  const botMember = guild?.members?.me || await guild?.members?.fetchMe?.().catch(() => null);
  const summary = {
    enabled: true,
    roleId,
    playerRoleId,
    spectatorRoleId,
    scope,
    assigned: 0,
    skipped: 0,
    failed: 0,
    reason: null,
    warnings: [],
  };
  const buckets = buildRewardBuckets({ participantIds, people, config });

  for (const bucket of buckets) {
    if (!bucket.roleId) {
      summary.warnings.push(`No reward role is configured for ${bucket.label}.`);
      continue;
    }

    const role = guild?.roles?.cache?.get(bucket.roleId) || await guild?.roles?.fetch(bucket.roleId).catch(() => null);
    if (!hasRewardRolePermission(botMember, role)) {
      summary.warnings.push(`GuildRank cannot assign the ${bucket.label} reward role yet. Give the bot Manage Roles and move the GuildRank bot role above the reward role.`);
      continue;
    }

    for (const discordUserId of bucket.userIds) {
      try {
        const member = guild.members.cache.get(discordUserId) || await guild.members.fetch(discordUserId);
        if (!member || member.user?.bot) {
          summary.skipped += 1;
          continue;
        }

        if (member.roles.cache.has(bucket.roleId)) {
          summary.skipped += 1;
          continue;
        }

        await member.roles.add(bucket.roleId, 'GuildRank finalized participant reward');
        summary.assigned += 1;
      } catch (error) {
        summary.failed += 1;
        logger.warn('participant_reward_role_assign_failed', {
          guild_id: guildId,
          discord_user_id: discordUserId,
          role_id: bucket.roleId,
          reward_bucket: bucket.label,
          source,
          error,
        });
      }
    }
  }

  if (summary.warnings.length > 0) {
    summary.reason = 'partial_or_missing_role_config';
  }

  return summary;
}

function formatRewardSummary(summary) {
  if (!summary || summary.enabled !== true) {
    return 'Participant reward role is disabled.';
  }

  const lines = [
    `Scope: \`${summary.scope || 'players_only'}\``,
  ];

  if (summary.scope === 'separate_roles') {
    lines.push(`Player role: ${summary.playerRoleId ? `<@&${summary.playerRoleId}>` : 'not set'}`);
    lines.push(`Spectator role: ${summary.spectatorRoleId ? `<@&${summary.spectatorRoleId}>` : 'not set'}`);
  } else {
    lines.push(`Role: ${summary.roleId ? `<@&${summary.roleId}>` : 'not set'}`);
  }

  if (summary.warnings?.length) {
    lines.push(`Warning: ${summary.warnings.join(' ')}`);
  }

  lines.push(
    `Assigned: ${summary.assigned}`,
    `Skipped: ${summary.skipped}`,
    `Failed: ${summary.failed}`,
  );

  return lines.join('\n');
}

module.exports = {
  assignParticipantRewardRoles,
  buildRewardBuckets,
  buildRewardParticipantIds,
  formatRewardSummary,
  hasRewardRolePermission,
};
