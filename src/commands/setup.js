const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder,
  ChannelType, PermissionFlagsBits, ComponentType,
} = require('discord.js');
const { saveGuildConfig, getGuildConfig } = require('../utils/guilds');
const { writeAuditLog } = require('../utils/audit');
const { checkMutationThrottle } = require('../utils/throttle');
const logger = require('../utils/logger');
const { BRAND_COLOR, GOLD_COLOR } = require('../../config/constants');

// Whitelists — validate BEFORE writing to DB
const VALID_TYPES = ['competitive', 'casual', 'mixed'];
const VALID_DAYS  = ['friday', 'saturday', 'sunday', 'monday'];
const REQUIRED_CHANNEL_PERMISSIONS = [
  { bit: PermissionFlagsBits.ViewChannel, label: 'View Channel' },
  { bit: PermissionFlagsBits.SendMessages, label: 'Send Messages' },
  { bit: PermissionFlagsBits.EmbedLinks, label: 'Embed Links' },
  { bit: PermissionFlagsBits.ReadMessageHistory, label: 'Read Message History' },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Set up GuildRank for your server — takes about 60 seconds')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ You need Manage Server to run `/setup`.', ephemeral: true });
    }

    const throttle = checkMutationThrottle({
      commandKey: 'setup',
      guildId: interaction.guildId,
      actorId: interaction.user.id,
      userWindowMs: 30_000,
      guildWindowMs: 15_000,
    });

    if (!throttle.allowed) {
      logger.info('mutation_throttled', {
        request_id: interaction.id,
        guild_id: interaction.guildId,
        actor_id: interaction.user.id,
        command: 'setup',
        scope: throttle.scope,
        retry_after_seconds: throttle.retryAfterSeconds,
      });
      return interaction.reply({
        content: `⏳ \`/setup\` is cooling down for this ${throttle.scope}. Try again in about ${throttle.retryAfterSeconds}s.`,
        ephemeral: true,
      });
    }

    const existing = await getGuildConfig(interaction.guildId);

    await interaction.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setTitle(existing ? '⚙️ Update GuildRank Setup' : '🚀 Welcome to GuildRank!')
          .setDescription(existing
            ? "You're already set up. Run through this to update your settings."
            : "3 quick questions and then I'm tracking.\n\nNo code. No spreadsheets. Just button clicks.")
          .addFields(
            { name: 'What I track automatically', value: '✅ VC joins/leaves\n✅ Session duration\n✅ Attendance streaks\n✅ Badge progress' },
            { name: 'What you need to do',         value: '👇 Click below to begin.' },
          )
          .setFooter({ text: 'GuildRank Setup · Step 0 of 3' }),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('setup_start').setLabel("Let's go →").setStyle(ButtonStyle.Success)
        ),
      ],
    });
    const replyMessage = await interaction.fetchReply();

    try {
      // STEP 1 — start button
      const s1 = await replyMessage.awaitMessageComponent({ componentType: ComponentType.Button, time: 120_000 });
      await s1.deferUpdate();

      // STEP 2 — channel picker
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(BRAND_COLOR)
            .setTitle('📢 Step 1 of 3 — Announcements Channel')
            .setDescription("Which channel should I post badge announcements and weekly recaps in?\n\n_You can change this later._")
            .setFooter({ text: 'GuildRank Setup · Step 1 of 3' }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId('setup_channel')
              .setPlaceholder('Select a text channel...')
              .addChannelTypes(ChannelType.GuildText)
          ),
        ],
      });

      const s2 = await replyMessage.awaitMessageComponent({ componentType: ComponentType.ChannelSelect, time: 120_000 });
      const announceChannelId = s2.values[0];

      const targetCh = interaction.guild.channels.cache.get(announceChannelId);
      const botMember = interaction.guild.members.me;
      const missingPermissions = getMissingChannelPermissions(targetCh, botMember);

      if (missingPermissions.length) {
        await s2.update({
          embeds: [new EmbedBuilder().setColor(0xff3d5a)
            .setTitle("❌ I can't post in that channel")
            .setDescription(
              `I need these permissions there:\n${missingPermissions.map(permission => `• ${permission}`).join('\n')}\n\nFix my permissions, then run \`/setup\` again.`
            )],
          components: [],
        });
        return;
      }
      await s2.deferUpdate();

      // STEP 3 — community type
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(BRAND_COLOR)
            .setTitle('🎮 Step 2 of 3 — Community Type')
            .setDescription("How does your games night usually work?")
            .setFooter({ text: 'GuildRank Setup · Step 2 of 3' }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('type_competitive').setLabel('🏆 Competitive — We track winners').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('type_casual').setLabel('🎉 Casual — No scores, just vibes').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('type_mixed').setLabel('⚡ Mixed — Depends on the night').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });

      const s3 = await replyMessage.awaitMessageComponent({ componentType: ComponentType.Button, time: 120_000 });
      const rawType = s3.customId.replace('type_', '');
      if (!VALID_TYPES.includes(rawType)) { await s3.update({ content: '❌ Invalid.', components: [], embeds: [] }); return; }
      await s3.deferUpdate();

      // STEP 4 — digest day
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(BRAND_COLOR)
            .setTitle('📅 Step 3 of 3 — Weekly Digest Day')
            .setDescription("Which day should I post the weekly leaderboard recap?")
            .setFooter({ text: 'GuildRank Setup · Step 3 of 3' }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('day_friday').setLabel('Friday').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('day_saturday').setLabel('Saturday').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('day_sunday').setLabel('Sunday').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('day_monday').setLabel('Monday').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });

      const s4 = await replyMessage.awaitMessageComponent({ componentType: ComponentType.Button, time: 120_000 });
      const rawDay = s4.customId.replace('day_', '');
      if (!VALID_DAYS.includes(rawDay)) { await s4.update({ content: '❌ Invalid.', components: [], embeds: [] }); return; }
      await s4.deferUpdate();

      // SAVE
      const savedConfig = await saveGuildConfig(interaction.guildId, {
        guild_name: interaction.guild.name,
        announce_channel_id: announceChannelId,
        community_type: rawType,
        digest_day: rawDay,
        is_setup: true,
        setup_by: interaction.user.id,
      });

      await writeAuditLog({
        guildId: interaction.guildId,
        actorDiscordId: interaction.user.id,
        actionType: existing ? 'guild_setup_updated' : 'guild_setup_created',
        targetType: 'guild_config',
        targetId: interaction.guildId,
        requestId: interaction.id,
        before: existing,
        after: savedConfig,
        metadata: {
          channel_id: announceChannelId,
          community_type: rawType,
          digest_day: rawDay,
        },
      }).catch(error => {
        logger.error('setup_audit_failed', {
          request_id: interaction.id,
          guild_id: interaction.guildId,
          actor_id: interaction.user.id,
          error,
        });
      });

      const typeLabels = { competitive: '🏆 Competitive', casual: '🎉 Casual', mixed: '⚡ Mixed' };

      // CONFIRMATION
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(GOLD_COLOR)
            .setTitle('✅ GuildRank is live!')
            .setDescription(`**${interaction.guild.name}** is set up. Tracking silently from now on.\n\nEvery VC join is logged automatically.`)
            .addFields(
              { name: '📢 Announcements', value: `<#${announceChannelId}>`,          inline: true },
              { name: '🎮 Type',          value: typeLabels[rawType],                 inline: true },
              { name: '📅 Digest',        value: `Every ${capitalise(rawDay)}`,       inline: true },
              { name: '\u200b', value: '\u200b' },
              { name: '📋 Commands', value:
                '`/leaderboard` · `/stats @player` · `/session log` · `/session attendance` · `/yearbook` · `/setup`'
              },
            )
            .setFooter({ text: 'GuildRank · Built by Mekula · AfriGen AI Studio' }),
        ],
        components: [],
      });

    } catch (err) {
      if (err.code !== 'InteractionCollectorError') {
        logger.error('setup_failed', {
          request_id: interaction.id,
          guild_id: interaction.guildId,
          actor_id: interaction.user.id,
          error: err,
        });
      }
      const msg = err.code === 'InteractionCollectorError'
        ? '⏰ Setup timed out. Run `/setup` again whenever you\'re ready.'
        : '❌ Something went wrong. Try again or contact the bot admin.';
      await interaction.editReply({ content: msg, components: [], embeds: [] }).catch(() => {});
    }
  },
};

function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function getMissingChannelPermissions(channel, botMember) {
  if (!channel || !botMember) {
    return ['View Channel', 'Send Messages', 'Embed Links', 'Read Message History'];
  }

  const permissions = channel.permissionsFor(botMember);
  if (!permissions) {
    return ['View Channel', 'Send Messages', 'Embed Links', 'Read Message History'];
  }

  return REQUIRED_CHANNEL_PERMISSIONS
    .filter(permission => !permissions.has(permission.bit))
    .map(permission => permission.label);
}
