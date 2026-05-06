// ─────────────────────────────────────────────────────────────
//  GuildRank — weeklyDigest.js (FIXED)
//
//  BUG FIXED: new Date().toLocaleDateString() is locale-dependent
//  and unreliable on Linux servers. Using getDay() number map instead.
// ─────────────────────────────────────────────────────────────

const { EmbedBuilder } = require('discord.js');
const supabase = require('../utils/supabase');
const logger = require('../utils/logger');
const { getDigestKey } = require('../utils/digestKey');
const { getRuntimeEnvironment } = require('../utils/env');
const { getAllGuilds }  = require('../utils/guilds');
const { normalizeGuildRuntimeConfig } = require('../utils/guildRuntimeConfig');
const {
  DEFAULT_DIGEST_TIME_UTC,
  getConfiguredDayName,
  getUtcTimeString,
  shouldSendDigestForConfig,
} = require('../utils/weeklyDigestSchedule');
const { getLeaderboard } = require('../utils/stats');
const { BRAND_COLOR }   = require('../../config/constants');

async function getDigestHistory(guildId, digestKey) {
  const { data, error } = await supabase
    .from('weekly_digest_history')
    .select('*')
    .eq('guild_id', guildId)
    .eq('digest_key', digestKey)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function reserveDigestRun({ guildId, digestKey, channelId, jobScopeKey }) {
  const existing = await getDigestHistory(guildId, digestKey);
  if (existing?.status === 'sent') {
    return { skipped: true, row: existing };
  }

  if (existing) {
    const { data, error } = await supabase
      .from('weekly_digest_history')
      .update({
        channel_id: channelId,
        job_scope_key: jobScopeKey,
        status: 'started',
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .eq('guild_id', guildId)
      .select()
      .single();

    if (error) throw error;
    return { skipped: false, row: data };
  }

  const { data, error } = await supabase
    .from('weekly_digest_history')
    .insert({
      guild_id: guildId,
      digest_key: digestKey,
      channel_id: channelId,
      job_scope_key: jobScopeKey,
      status: 'started',
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw error;
  return { skipped: false, row: data };
}

async function completeDigestRun(guildId, id, messageId) {
  let query = supabase
    .from('weekly_digest_history')
    .update({
      status: 'sent',
      message_id: messageId,
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error_message: null,
    })
    .eq('id', id);

  if (guildId) query = query.eq('guild_id', guildId);

  const { error } = await query;

  if (error) throw error;
}

async function failDigestRun(guildId, id, errorMessage) {
  let query = supabase
    .from('weekly_digest_history')
    .update({
      status: 'failed',
      error_message: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (guildId) query = query.eq('guild_id', guildId);

  const { error } = await query;

  if (error) throw error;
}

async function sendWeeklyDigest(client, { now = new Date() } = {}) {
  const digestKey = getDigestKey(now);

  const guilds   = await getAllGuilds();
  const matching = guilds
    .map(normalizeGuildRuntimeConfig)
    .filter(config => shouldSendDigestForConfig(config, now));

  logger.info('weekly_digest_started', {
    digest_key: digestKey,
    matching_guilds: matching.length,
    utc_time: getUtcTimeString(now),
  });

  for (const config of matching) {
    try {
      const guild = client.guilds.cache.get(config.guild_id);
      if (!guild) continue;

      const rows = await getLeaderboard(config.guild_id, 'total_events', 5);
      if (!rows.length) continue;

      const digestChannelId = config.digest_channel_id || config.announce_channel_id;
      const channel = guild.channels.cache.get(digestChannelId);
      if (!channel) continue;
      if (!channel.isTextBased?.()) continue;

      const reservation = await reserveDigestRun({
        guildId: config.guild_id,
        digestKey,
        channelId: digestChannelId,
        jobScopeKey: `weekly_digest:${getRuntimeEnvironment()}:${digestKey}`,
      });

      if (reservation.skipped) {
        logger.info('weekly_digest_skipped_existing', {
          guild_id: config.guild_id,
          digest_key: digestKey,
        });
        continue;
      }

      const lines = rows.map((r, i) => {
        const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
        const name   = r.player?.username || `<@${r.discord_id}>`;
        return `${medals[i]} **${name}** — ${r.total_events} sessions · ${r.current_streak}🔥 streak`;
      });

      const message = await channel.send({
        allowedMentions: { parse: [] },
        embeds: [
          new EmbedBuilder()
            .setColor(BRAND_COLOR)
            .setTitle('📊 Weekly GuildRank Recap')
            .setDescription("Here's who's been showing up. The board doesn't lie. 🏆")
            .addFields(
              { name: 'Top 5 — Sessions Attended', value: lines.join('\n') },
              { name: '\u200b', value: '`/leaderboard` for full board · `/stats @you` for your profile' },
            )
            .setFooter({ text: 'GuildRank · Weekly Digest · Built by Mekula' })
            .setTimestamp(),
        ],
      });

      await completeDigestRun(config.guild_id, reservation.row.id, message.id);
      logger.info('weekly_digest_sent', {
        guild_id: config.guild_id,
        guild_name: guild.name,
        digest_key: digestKey,
        channel_id: digestChannelId,
        message_id: message.id,
      });
    } catch (e) {
      logger.error('weekly_digest_failed', {
        guild_id: config.guild_id,
        digest_key: digestKey,
        error: e,
      });

      const existing = await getDigestHistory(config.guild_id, digestKey).catch(() => null);
      if (existing?.id) {
        await failDigestRun(config.guild_id, existing.id, e.message || 'unknown_error').catch(() => {});
      }
    }
  }
}

module.exports = {
  getConfiguredDayName,
  getDigestKey,
  getUtcTimeString,
  sendWeeklyDigest,
  shouldSendDigestForConfig,
  DEFAULT_DIGEST_TIME_UTC,
};
