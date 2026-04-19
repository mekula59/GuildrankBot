const {
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const { isSetup } = require('../utils/guilds');
const { checkMutationThrottle } = require('../utils/throttle');
const { reconcileTrackedChannelState } = require('../utils/sessionCandidates');
const {
  disableTrackedVoiceChannel,
  getTrackedVoiceChannel,
  listTrackedVoiceChannels,
  upsertTrackedVoiceChannel,
} = require('../utils/trackedVoiceChannels');
const { closeOpenVoicePresenceSegmentsForChannel } = require('../utils/voicePresence');
const logger = require('../utils/logger');
const { BRAND_COLOR } = require('../../config/constants');

const SESSION_TYPE_CHOICES = [
  { name: 'Competitive', value: 'competitive' },
  { name: 'Casual', value: 'casual' },
];

function normalizeGameLabel(input) {
  const normalized = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!normalized) {
    throw new Error('Game label must contain letters or numbers. Try labels like `codm`, `among_us`, `gartic`, `general_gaming`, or `mixed`.');
  }

  if (normalized.length > 40) {
    throw new Error('Game label is too long after normalization. Keep it short, like `codm` or `general_gaming`.');
  }

  return normalized;
}

function describeRules(row) {
  const isDefault = row.min_active_members === 2
    && row.min_candidate_duration_minutes === 10
    && row.min_participant_presence_minutes === 5
    && row.grace_gap_seconds === 180;

  if (isDefault) return 'Standard';
  return `${row.min_active_members} members • ${row.min_candidate_duration_minutes}m hold • ${row.min_participant_presence_minutes}m presence • ${row.grace_gap_seconds}s grace`;
}

function formatTrackedVoiceRow(row) {
  return [
    `Channel: <#${row.channel_id}>`,
    `Default game: \`${row.game_key}\``,
    `Default session type: \`${row.session_type}\``,
    `State: ${row.tracking_enabled ? 'enabled' : 'disabled'}`,
    `Rules: ${describeRules(row)}`,
  ].join('\n');
}

function buildTrackedVoiceListEntry(row) {
  return [
    `Channel: <#${row.channel_id}>`,
    `Default profile: \`${row.game_key}\` • \`${row.session_type}\``,
    `Tracking: ${row.tracking_enabled ? 'enabled' : 'disabled'}`,
  ].join('\n');
}

function resolveConfigValue(interaction, optionName, currentValue) {
  const value = interaction.options.getInteger(optionName);
  return value ?? currentValue;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vc')
    .setDescription('Manage tracked voice channels for VC-assisted session capture')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('track')
        .setDescription('Save the default VC session profile for one voice channel')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Voice channel to track')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true)
        )
        .addStringOption(option => option.setName('game').setDescription('Default activity label, e.g. codm, among_us, general_gaming, mixed').setRequired(true).setMaxLength(80))
        .addStringOption(option =>
          option
            .setName('session_type')
            .setDescription('Default session type candidates should inherit')
            .setRequired(true)
            .addChoices(...SESSION_TYPE_CHOICES)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('config')
        .setDescription('Adjust advanced detection rules for a tracked voice channel')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Tracked voice channel to tune')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true)
        )
        .addIntegerOption(option => option.setName('min_active_members').setDescription('Minimum concurrent human members').setRequired(false).setMinValue(2))
        .addIntegerOption(option => option.setName('min_candidate_duration_minutes').setDescription('Minutes the threshold must hold before opening a candidate').setRequired(false).setMinValue(1))
        .addIntegerOption(option => option.setName('min_participant_presence_minutes').setDescription('Minimum participant presence to meet threshold').setRequired(false).setMinValue(1))
        .addIntegerOption(option => option.setName('grace_gap_seconds').setDescription('Seconds below threshold before closing').setRequired(false).setMinValue(0))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('untrack')
        .setDescription('Disable tracking for a voice channel')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Voice channel to stop tracking')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true)
        )
        .addStringOption(option => option.setName('reason').setDescription('Why this channel is being disabled').setRequired(false).setMaxLength(200))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List tracked voice channels for this server')
        .addBooleanOption(option => option.setName('include_disabled').setDescription('Include disabled tracked channels').setRequired(false))
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ You need Manage Server to use VC tracking commands.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const throttle = checkMutationThrottle({
      commandKey: `vc_${subcommand}`,
      guildId: interaction.guildId,
      actorId: interaction.user.id,
      userWindowMs: 15_000,
      guildWindowMs: 5_000,
    });

    if (!throttle.allowed) {
      logger.info('mutation_throttled', {
        request_id: interaction.id,
        guild_id: interaction.guildId,
        actor_id: interaction.user.id,
        command: `vc_${subcommand}`,
        scope: throttle.scope,
        retry_after_seconds: throttle.retryAfterSeconds,
      });
      return interaction.editReply({
        content: `⏳ \`/vc ${subcommand}\` is cooling down for this ${throttle.scope}. Try again in about ${throttle.retryAfterSeconds}s.`,
      });
    }

    if (!(await isSetup(interaction.guildId))) {
      return interaction.editReply({ content: '⚙️ Run `/setup` first!' });
    }

    try {
      if (subcommand === 'track') {
        const channel = interaction.options.getChannel('channel', true);
        const gameKey = normalizeGameLabel(interaction.options.getString('game', true));
        const row = await upsertTrackedVoiceChannel({
          guildId: interaction.guildId,
          channelId: channel.id,
          channelNameSnapshot: channel.name,
          gameKey,
          sessionType: interaction.options.getString('session_type', true),
          actorDiscordId: interaction.user.id,
          requestId: interaction.id,
        });

        const embed = new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setTitle('✅ VC Default Profile Saved')
          .setDescription(formatTrackedVoiceRow(row))
          .addFields({
            name: 'How It Works',
            value: 'Candidates from this voice channel inherit this saved default profile automatically. You can still override details later during finalize.',
          })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      if (subcommand === 'config') {
        const channel = interaction.options.getChannel('channel', true);
        const current = await getTrackedVoiceChannel(interaction.guildId, channel.id, { useCache: false });

        if (!current) {
          return interaction.editReply('ℹ️ That voice channel is not tracked yet. Run `/vc track` first to save its default profile.');
        }

        const row = await upsertTrackedVoiceChannel({
          guildId: interaction.guildId,
          channelId: channel.id,
          channelNameSnapshot: channel.name,
          gameKey: current.game_key,
          sessionType: current.session_type,
          minActiveMembers: resolveConfigValue(interaction, 'min_active_members', current.min_active_members),
          minCandidateDurationMinutes: resolveConfigValue(interaction, 'min_candidate_duration_minutes', current.min_candidate_duration_minutes),
          minParticipantPresenceMinutes: resolveConfigValue(interaction, 'min_participant_presence_minutes', current.min_participant_presence_minutes),
          graceGapSeconds: resolveConfigValue(interaction, 'grace_gap_seconds', current.grace_gap_seconds),
          actorDiscordId: interaction.user.id,
          requestId: interaction.id,
        });

        const embed = new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setTitle('⚙️ VC Detection Rules Updated')
          .setDescription(formatTrackedVoiceRow(row))
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      if (subcommand === 'untrack') {
        const channel = interaction.options.getChannel('channel', true);
        const reason = interaction.options.getString('reason') || 'disabled_by_operator';
        const row = await disableTrackedVoiceChannel({
          guildId: interaction.guildId,
          channelId: channel.id,
          actorDiscordId: interaction.user.id,
          requestId: interaction.id,
          reason,
        });

        if (!row) {
          return interaction.editReply('ℹ️ That voice channel is not currently tracked.');
        }

        await closeOpenVoicePresenceSegmentsForChannel({
          guildId: interaction.guildId,
          channelId: channel.id,
          leftAt: new Date(),
        });
        await reconcileTrackedChannelState(interaction.guild, channel.id);

        const embed = new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setTitle('🛑 Voice Channel Tracking Disabled')
          .setDescription(formatTrackedVoiceRow(row))
          .addFields({ name: 'Reason', value: reason })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      const includeDisabled = interaction.options.getBoolean('include_disabled') ?? false;
      const rows = await listTrackedVoiceChannels(interaction.guildId, { includeDisabled });

      if (!rows.length) {
        return interaction.editReply('ℹ️ No tracked voice channels are configured for this server yet.');
      }

      const embed = new EmbedBuilder()
        .setColor(BRAND_COLOR)
        .setTitle('🎧 Tracked VC Defaults')
        .setDescription(rows.slice(0, 8).map(row => buildTrackedVoiceListEntry(row)).join('\n\n'))
        .addFields({
          name: 'Label Tips',
          value: 'Use short reusable defaults like `codm`, `among_us`, `gartic`, `general_gaming`, or `mixed`.',
        })
        .setFooter({ text: rows.length > 8 ? `Showing 8 of ${rows.length} tracked channels` : `${rows.length} tracked channels` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('vc_command_failed', {
        request_id: interaction.id,
        guild_id: interaction.guildId,
        actor_id: interaction.user.id,
        command: subcommand,
        error,
      });
      return interaction.editReply(`❌ VC command failed. ${error.message || 'Try again.'}`);
    }
  },
};
