// ─────────────────────────────────────────────────────────────
//  GuildRank — guildDelete.js (NEW)
//
//  Fires when the bot is kicked or the server is deleted.
//  Marks the guild as inactive so digest jobs skip it.
//  Does NOT delete data — the server could re-invite the bot.
// ─────────────────────────────────────────────────────────────

const supabase = require('../utils/supabase');
const logger = require('../utils/logger');
const { writeAuditLog } = require('../utils/audit');
const { invalidateGuildConfig } = require('../utils/guilds');

module.exports = {
  name: 'guildDelete',

  async execute(guild) {
    const leftAt = new Date().toISOString();
    logger.info('guild_deleted', { guild_id: guild.id, guild_name: guild.name });

    await supabase
      .from('guild_configs')
      .update({ is_setup: false, left_at: leftAt })
      .eq('guild_id', guild.id);

    await writeAuditLog({
      guildId: guild.id,
      actionType: 'guild_config_deactivated',
      targetType: 'guild_config',
      targetId: guild.id,
      after: { is_setup: false, left_at: leftAt },
      metadata: { trigger: 'guildDelete' },
    }).catch(() => {});

    invalidateGuildConfig(guild.id);
  },
};
