const logger = require('../utils/logger');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client) {
    if (!interaction.isChatInputCommand()) return;
    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) return;

    logger.info('command_received', {
      request_id: interaction.id,
      guild_id: interaction.guildId,
      actor_id: interaction.user.id,
      command: interaction.commandName,
    });

    try {
      await cmd.execute(interaction);
    } catch (e) {
      logger.error('command_failed', {
        request_id: interaction.id,
        guild_id: interaction.guildId,
        actor_id: interaction.user.id,
        command: interaction.commandName,
        error: e,
      });
      const r = { content: '❌ Something went wrong.', ephemeral: true };
      if (interaction.deferred) {
        await interaction.editReply({ content: r.content, embeds: [], components: [] }).catch(() => {});
        return;
      }

      if (interaction.replied) {
        await interaction.followUp(r).catch(() => {});
        return;
      }

      await interaction.reply(r).catch(() => {});
    }
  },
};
