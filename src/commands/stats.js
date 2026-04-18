const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getPlayerStats } = require('../utils/stats');
const { formatBadges } = require('../utils/badges');
const { isSetup } = require('../utils/guilds');
const { BRAND_COLOR } = require('../../config/constants');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription("View a player's GuildRank profile")
    .setDMPermission(false)
    .addUserOption(o =>
      o.setName('player').setDescription('Leave blank to see your own stats').setRequired(false)
    ),

  async execute(interaction) {
    if (!(await isSetup(interaction.guildId))) {
      return interaction.reply({ content: '⚙️ Run `/setup` first!', ephemeral: true });
    }

    await interaction.deferReply();
    const target = interaction.options.getUser('player') || interaction.user;
    const stats  = await getPlayerStats(target.id, interaction.guildId);

    if (!stats) {
      return interaction.editReply(`**${target.username}** hasn't attended any tracked sessions yet.`);
    }

    const hours   = Math.floor(stats.total_vc_minutes / 60);
    const mins    = stats.total_vc_minutes % 60;
    const lastTs  = stats.last_seen
      ? `<t:${Math.floor(new Date(stats.last_seen).getTime()/1000)}:R>`
      : '—';

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setTitle(`📊 ${target.username}`)
          .setThumbnail(target.displayAvatarURL())
          .addFields(
            { name: '🎮 Sessions', value: `${stats.total_events}`, inline: true },
            { name: '📝 Manual Logs', value: `${stats.total_manual_sessions || 0}`, inline: true },
            { name: '🎧 VC Sessions', value: `${stats.total_vc_sessions || 0}`, inline: true },
            { name: '⏱️ VC Time', value: `${hours}h ${mins}m`, inline: true },
            { name: '🏆 Wins', value: `${stats.wins || 0}`, inline: true },
            { name: '⭐ MVPs', value: `${stats.mvps || 0}`, inline: true },
            { name: '🔥 Streak', value: `${stats.current_streak}`, inline: true },
            { name: '⚡ Best Streak', value: `${stats.longest_streak}`, inline: true },
            { name: '📅 Last Seen', value: lastTs, inline: true },
            { name: '🏅 Badges', value: formatBadges(stats.badges) },
          )
          .setFooter({ text: 'GuildRank · Built by Mekula' })
          .setTimestamp(),
      ],
    });
  },
};
