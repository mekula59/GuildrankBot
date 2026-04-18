const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { BRAND_COLOR } = require('../../config/constants');

module.exports = {
  name: 'guildCreate',

  async execute(guild, client) {
    console.log(`✅ Joined new server: ${guild.name} (${guild.id})`);

    // Find the best channel to send welcome message
    const channel = guild.channels.cache.find(c =>
      c.isTextBased() &&
      c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages) &&
      ['general', 'welcome', 'bot-commands', 'bots', 'commands'].some(n => c.name.includes(n))
    ) || guild.channels.cache.find(c =>
      c.isTextBased() &&
      c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
    );

    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle('👋 GuildRank is here!')
      .setDescription(
        `Hey **${guild.name}** — I'm GuildRank.\n\n` +
        `I track who shows up to your games nights, how long they spend in VC, ` +
        `who's on a streak, and who your most loyal members are — all automatically, with zero setup from you.\n\n` +
        `**Get started in 60 seconds:**`
      )
      .addFields({
        name: '👇 One command to set up everything',
        value: '```/setup```\nRun this and I\'ll walk you through the rest. Takes about a minute.',
      })
      .setFooter({ text: 'GuildRank · Built by Mekula · AfriGen AI Studio' });

    await channel.send({ embeds: [embed] });
  },
};
