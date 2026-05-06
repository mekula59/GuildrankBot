const { PermissionFlagsBits } = require('discord.js');
const logger = require('./logger');

const EMPTY_REWARD_SUMMARY = {
  enabled: false,
  roleId: null,
  assigned: 0,
  skipped: 0,
  failed: 0,
  reason: 'disabled',
};

function buildRewardParticipantIds({ participantIds = [], people = [], scope = 'players_only' } = {}) {
  const ids = new Set((participantIds || []).filter(Boolean));

  if (scope === 'players_and_spectators') {
    for (const row of people || []) {
      if (row?.discord_user_id) ids.add(row.discord_user_id);
    }
  }

  return [...ids];
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
  const roleId = config?.participant_reward_role_id || null;
  const enabled = config?.participant_reward_enabled === true;
  const scope = config?.participant_reward_scope || 'players_only';

  if (!enabled || !roleId) {
    return {
      ...EMPTY_REWARD_SUMMARY,
      enabled,
      roleId,
      reason: enabled ? 'missing_role' : 'disabled',
    };
  }

  const role = guild?.roles?.cache?.get(roleId) || await guild?.roles?.fetch(roleId).catch(() => null);
  const botMember = guild?.members?.me || await guild?.members?.fetchMe?.().catch(() => null);

  if (!hasRewardRolePermission(botMember, role)) {
    return {
      enabled: true,
      roleId,
      assigned: 0,
      skipped: 0,
      failed: 0,
      reason: 'missing_permission_or_hierarchy',
    };
  }

  const rewardIds = buildRewardParticipantIds({ participantIds, people, scope });
  const summary = {
    enabled: true,
    roleId,
    assigned: 0,
    skipped: 0,
    failed: 0,
    reason: null,
  };

  for (const discordUserId of rewardIds) {
    try {
      const member = guild.members.cache.get(discordUserId) || await guild.members.fetch(discordUserId);
      if (!member || member.user?.bot) {
        summary.skipped += 1;
        continue;
      }

      if (member.roles.cache.has(roleId)) {
        summary.skipped += 1;
        continue;
      }

      await member.roles.add(roleId, 'GuildRank finalized participant reward');
      summary.assigned += 1;
    } catch (error) {
      summary.failed += 1;
      logger.warn('participant_reward_role_assign_failed', {
        guild_id: guildId,
        discord_user_id: discordUserId,
        role_id: roleId,
        source,
        error,
      });
    }
  }

  return summary;
}

function formatRewardSummary(summary) {
  if (!summary || summary.enabled !== true) {
    return 'Participant reward role is disabled.';
  }

  if (summary.reason === 'missing_permission_or_hierarchy') {
    return 'GuildRank cannot assign that role yet. Give the bot Manage Roles and move the GuildRank bot role above the reward role.';
  }

  return [
    `Role: <@&${summary.roleId}>`,
    `Assigned: ${summary.assigned}`,
    `Skipped: ${summary.skipped}`,
    `Failed: ${summary.failed}`,
  ].join('\n');
}

module.exports = {
  assignParticipantRewardRoles,
  buildRewardParticipantIds,
  formatRewardSummary,
  hasRewardRolePermission,
};
