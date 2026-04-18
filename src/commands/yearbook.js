const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getLeaderboard } = require('../utils/stats');
const { isSetup } = require('../utils/guilds');
const { GOLD_COLOR } = require('../../config/constants');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('yearbook')
    .setDescription('Generate the community yearbook — legends, streaks, and awards')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) {
      return interaction.reply({ content: '❌ You need Manage Events to generate the yearbook.', ephemeral: true });
    }

    if (!(await isSetup(interaction.guildId))) {
      return interaction.reply({ content: '⚙️ Run `/setup` first!', ephemeral: true });
    }

    await interaction.deferReply();
    const gid = interaction.guildId;

    const [byEvents, byStreak, byHours] = await Promise.all([
      getLeaderboard(gid, 'total_events',     5),
      getLeaderboard(gid, 'longest_streak',   3),
      getLeaderboard(gid, 'total_vc_minutes', 3),
    ]);

    const name  = r => r.player?.username || `<@${r.discord_id}>`;
    const M     = ['🥇','🥈','🥉','4️⃣','5️⃣'];

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(GOLD_COLOR)
          .setTitle(`📖 ${interaction.guild.name} — Community Yearbook`)
          .setDescription('A permanent record of who showed up, who grinded, and who became a legend.')
          .addFields(
            {
              name: '🏆 Most Sessions — Always There',
              value: byEvents.map((r,i) => `${M[i]} **${name(r)}** — ${r.total_events} sessions`).join('\n') || '—',
            },
            {
              name: '🔥 Longest Streak — Never Quit',
              value: byStreak.map((r,i) => `${M[i]} **${name(r)}** — ${r.longest_streak} in a row`).join('\n') || '—',
              inline: true,
            },
            {
              name: '⏱️ Most VC Time — Community Pillar',
              value: byHours.map((r,i) => `${M[i]} **${name(r)}** — ${Math.floor(r.total_vc_minutes/60)}h`).join('\n') || '—',
              inline: true,
            },
          )
          .setFooter({ text: 'GuildRank · Your community history, preserved. · Built by Mekula' })
          .setTimestamp(),
      ],
    });
  },
};
