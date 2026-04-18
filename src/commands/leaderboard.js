const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getLeaderboard } = require('../utils/stats');
const { isSetup } = require('../utils/guilds');
const { BRAND_COLOR, GOLD_COLOR } = require('../../config/constants');

const MEDALS  = ['🥇','🥈','🥉','4.','5.','6.','7.','8.','9.','10.'];
const METRICS = {
  sessions: { col: 'total_events',     label: 'Most Sessions Attended', color: BRAND_COLOR },
  streak:   { col: 'current_streak',   label: 'Current Active Streak',  color: 0xff6b35    },
  hours:    { col: 'total_vc_minutes', label: 'Most VC Time',           color: GOLD_COLOR   },
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the GuildRank leaderboard')
    .setDMPermission(false)
    .addStringOption(o =>
      o.setName('type').setDescription('Rank by').setRequired(false)
        .addChoices(
          { name: '🎮 Sessions Attended', value: 'sessions' },
          { name: '🔥 Active Streak',     value: 'streak'   },
          { name: '⏱️ VC Hours',          value: 'hours'    },
        )
    ),

  async execute(interaction) {
    if (!(await isSetup(interaction.guildId))) {
      return interaction.reply({ content: '⚙️ Run `/setup` first to activate GuildRank!', ephemeral: true });
    }

    await interaction.deferReply();
    const type   = interaction.options.getString('type') || 'sessions';
    const metric = METRICS[type];
    const rows   = await getLeaderboard(interaction.guildId, metric.col, 10);

    if (!rows.length) {
      return interaction.editReply("No data yet — start showing up to sessions! 👀");
    }

    const lines = rows.map((r, i) => {
      const name = r.player?.username || `<@${r.discord_id}>`;
      let val = '';
      if (type === 'sessions') val = `${r.total_events} sessions`;
      if (type === 'streak')   val = `${r.current_streak} 🔥`;
      if (type === 'hours')    val = `${Math.floor(r.total_vc_minutes/60)}h ${r.total_vc_minutes%60}m`;
      return `${MEDALS[i]} **${name}** — ${val}`;
    });

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(metric.color)
          .setTitle(`🏆 ${metric.label}`)
          .setDescription(lines.join('\n'))
          .setFooter({ text: `${interaction.guild.name} · GuildRank · Built by Mekula` })
          .setTimestamp(),
      ],
    });
  },
};
