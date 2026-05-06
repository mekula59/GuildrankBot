const logger = require('../utils/logger');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client) {
    if (interaction.isAutocomplete()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd?.autocomplete) return;

      try {
        await cmd.autocomplete(interaction);
      } catch (e) {
        logger.error('command_autocomplete_failed', {
          request_id: interaction.id,
          guild_id: interaction.guildId,
          actor_id: interaction.user?.id,
          command: interaction.commandName,
          error: e,
        });
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    if (interaction.isButton()) {
      const sessionCommand = client.commands.get('session');
      if (sessionCommand?.handleButton) {
        try {
          if (await sessionCommand.handleButton(interaction)) {
            return;
          }
        } catch (e) {
          logger.error('button_interaction_failed', {
            request_id: interaction.id,
            guild_id: interaction.guildId,
            actor_id: interaction.user?.id,
            custom_id: interaction.customId,
            error: e,
          });
          const response = { content: '❌ Button action failed. Please try again or ask an operator to review the live session.', ephemeral: true };
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp(response).catch(() => {});
            return;
          }
          await interaction.reply(response).catch(() => {});
          return;
        }
      }
    }

    if (!interaction.isChatInputCommand()) return;
    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) {
      logger.error('command_handler_missing', {
        request_id: interaction.id,
        guild_id: interaction.guildId,
        actor_id: interaction.user.id,
        command: interaction.commandName,
      });
      return interaction.reply({
        content: '❌ This command is registered in Discord, but this bot instance does not have its handler loaded. Redeploy the Railway service from the latest commit and redeploy slash commands.',
        ephemeral: true,
      }).catch(() => {});
    }

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
