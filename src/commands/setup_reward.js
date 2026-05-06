const {
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { getGuildConfig, saveGuildConfig } = require('../utils/guilds');
const { normalizeGuildRuntimeConfig } = require('../utils/guildRuntimeConfig');
const { hasRewardRolePermission } = require('../utils/participantRewards');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup_reward')
    .setDescription('Configure the participant reward role assigned after finalized sessions')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('role')
        .setDescription('Set the Discord role GuildRank gives finalized players')
        .addRoleOption(option =>
          option
            .setName('role')
            .setDescription('Reward role to assign after finalize')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('enabled')
        .setDescription('Enable or disable participant reward role assignment')
        .addBooleanOption(option =>
          option
            .setName('enabled')
            .setDescription('Whether to assign the configured role after finalize')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('scope')
        .setDescription('Choose who receives the reward role')
        .addStringOption(option =>
          option
            .setName('scope')
            .setDescription('Reward scope')
            .setRequired(true)
            .addChoices(
              { name: 'Players only', value: 'players_only' },
              { name: 'Players and spectators', value: 'players_and_spectators' },
            )
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Show participant reward role configuration')
    ),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ You need Manage Server to configure participant rewards.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const subcommand = interaction.options.getSubcommand();
      const existing = await getGuildConfig(interaction.guildId);
      if (!existing) {
        return interaction.editReply('⚙️ Run `/setup` first before configuring participant rewards.');
      }

      if (subcommand === 'role') {
        const role = interaction.options.getRole('role', true);
        if (!hasRewardRolePermission(interaction.guild.members.me, role)) {
          return interaction.editReply('❌ GuildRank cannot assign that role yet. Give the bot Manage Roles and move the GuildRank bot role above the reward role.');
        }

        const saved = await saveGuildConfig(interaction.guildId, {
          participant_reward_role_id: role.id,
          participant_reward_enabled: true,
        });
        const config = normalizeGuildRuntimeConfig(saved);

        return interaction.editReply([
          `✅ Participant reward role set to <@&${config.participant_reward_role_id}>.`,
          'GuildRank will assign it only after `/session finalize` succeeds.',
        ].join('\n'));
      }

      if (subcommand === 'enabled') {
        const enabled = interaction.options.getBoolean('enabled', true);
        const saved = await saveGuildConfig(interaction.guildId, {
          participant_reward_enabled: enabled,
        });
        const config = normalizeGuildRuntimeConfig(saved);

        return interaction.editReply(`✅ Participant reward role assignment is now ${config.participant_reward_enabled ? 'enabled' : 'disabled'}.`);
      }

      if (subcommand === 'scope') {
        const scope = interaction.options.getString('scope', true);
        const saved = await saveGuildConfig(interaction.guildId, {
          participant_reward_scope: scope,
        });
        const config = normalizeGuildRuntimeConfig(saved);

        return interaction.editReply(`✅ Participant reward scope set to \`${config.participant_reward_scope}\`.`);
      }

      const config = normalizeGuildRuntimeConfig(existing);
      return interaction.editReply([
        `Enabled: \`${config.participant_reward_enabled}\``,
        `Role: ${config.participant_reward_role_id ? `<@&${config.participant_reward_role_id}>` : 'not set'}`,
        `Scope: \`${config.participant_reward_scope}\``,
        'Rewards are assigned only after `/session finalize` succeeds.',
      ].join('\n'));
    } catch (error) {
      logger.error('setup_reward_failed', {
        request_id: interaction.id,
        guild_id: interaction.guildId,
        actor_id: interaction.user.id,
        subcommand: interaction.options.getSubcommand(false),
        error,
      });
      return interaction.editReply('❌ Participant reward settings could not be read or saved. Check Railway logs and verify migration 017 is applied.');
    }
  },
};
