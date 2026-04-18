const { EmbedBuilder } = require('discord.js');

const supabase = require('../utils/supabase');
const logger = require('../utils/logger');
const { ensurePlayerProfile, finalizeVcSession } = require('../utils/stats');
const { formatBadges } = require('../utils/badges');
const { isSetup, getGuildConfig } = require('../utils/guilds');
const { syncVoicePresenceFromStateChange } = require('../utils/voicePresence');
const { syncSessionCandidatesFromStateChange } = require('../utils/sessionCandidates');
const { BRAND_COLOR } = require('../../config/constants');

const active = new Map();

function buildActiveKey(userId, guildId) {
  return `${userId}:${guildId}`;
}

function buildProfile(member, guildId) {
  if (!member?.user) return null;

  return {
    discordId: member.user.id,
    guildId,
    username: member.user.username,
    avatarUrl: member.user.displayAvatarURL(),
  };
}

function isTrackableVoiceChannel(guild, channelId) {
  return Boolean(channelId && channelId !== guild?.afkChannelId);
}

async function markChannelHasCompanions(guild, channelId) {
  if (!isTrackableVoiceChannel(guild, channelId)) return;

  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased?.()) return;

  const humanMembers = [...channel.members.values()].filter(member => !member.user?.bot);
  if (humanMembers.length < 2) return;

  const sessionIds = [];
  for (const member of humanMembers) {
    const key = buildActiveKey(member.id, guild.id);
    const session = active.get(key);
    if (!session?.sessionId) continue;

    if (!session.hadCompanion) {
      active.set(key, { ...session, hadCompanion: true });
    }

    sessionIds.push(session.sessionId);
  }

  if (!sessionIds.length) return;

  const uniqueSessionIds = [...new Set(sessionIds)];
  const { error } = await supabase
    .from('vc_sessions')
    .update({ had_companion: true })
    .in('id', uniqueSessionIds);

  if (error) throw error;
}

async function getOpenSession(discordId, guildId) {
  const { data } = await supabase
    .from('vc_sessions')
    .select('*')
    .eq('discord_id', discordId)
    .eq('guild_id', guildId)
    .is('left_at', null)
    .order('joined_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data || null;
}

async function startVcSession({ userId, guildId, channelId, joinedAt, member }) {
  const profile = buildProfile(member, guildId);
  if (profile) {
    await ensurePlayerProfile(profile);
  }

  const existingSession = await getOpenSession(userId, guildId);
  if (existingSession) {
    const { error: updateError } = await supabase
      .from('vc_sessions')
      .update({ channel_id: channelId })
      .eq('id', existingSession.id);

    if (updateError) throw updateError;

    active.set(buildActiveKey(userId, guildId), {
      sessionId: existingSession.id,
      joinedAt: new Date(existingSession.joined_at),
      guildId,
      userId,
      channelId,
      hadCompanion: Boolean(existingSession.had_companion),
      name: profile?.username || member?.displayName || 'Unknown',
    });

    logger.info('vc_session_resumed_existing', {
      guild_id: guildId,
      user_id: userId,
      session_id: existingSession.id,
      channel_id: channelId,
    });
    return;
  }

  const { data: sessionRow, error } = await supabase
    .from('vc_sessions')
    .insert({
      discord_id: userId,
      guild_id: guildId,
      channel_id: channelId,
      joined_at: joinedAt.toISOString(),
      left_at: null,
      duration_minutes: null,
      raw_duration_minutes: null,
      credited_minutes: null,
      had_companion: false,
      recovered: false,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      const openSession = await getOpenSession(userId, guildId);
      if (!openSession) throw error;

      active.set(buildActiveKey(userId, guildId), {
        sessionId: openSession.id,
        joinedAt: new Date(openSession.joined_at),
        guildId,
        userId,
        channelId,
        hadCompanion: Boolean(openSession.had_companion),
        name: profile?.username || member?.displayName || 'Unknown',
      });
      return;
    }

    throw error;
  }

  active.set(buildActiveKey(userId, guildId), {
    sessionId: sessionRow.id,
    joinedAt,
    guildId,
    userId,
    channelId,
    hadCompanion: false,
    name: profile?.username || member?.displayName || 'Unknown',
  });

  logger.info('vc_session_started', {
    guild_id: guildId,
    user_id: userId,
    session_id: sessionRow.id,
    channel_id: channelId,
  });
}

async function closeVcSession({ guild, userId, guildId, member, leftAt = new Date(), recovered = false }) {
  const key = buildActiveKey(userId, guildId);
  let session = active.get(key);

  if (!session) {
    const openSession = await getOpenSession(userId, guildId);
    if (openSession) {
      session = {
        sessionId: openSession.id,
        joinedAt: new Date(openSession.joined_at),
        guildId,
        userId,
        channelId: openSession.channel_id,
        hadCompanion: Boolean(openSession.had_companion),
        name: member?.user?.username || 'Unknown',
      };
    }
  }

  if (!session?.sessionId) {
    active.delete(key);
    return { counted: false, stats: null, durationMinutes: 0 };
  }

  const durationMinutes = Math.max(0, Math.floor((leftAt - session.joinedAt) / 60000));
  const result = await finalizeVcSession({
    sessionId: session.sessionId,
    discordId: userId,
    guildId,
    durationMinutes,
    hadCompanion: Boolean(session.hadCompanion),
    leftAt,
    recovered,
    profile: buildProfile(member, guildId),
  });

  active.delete(key);

  if (result.stats?.newBadges?.length && guild) {
    await announceBadge(guild, member?.user?.username || session.name, result.stats.newBadges, result.stats);
  }

  logger.info('vc_session_closed', {
    guild_id: guildId,
    user_id: userId,
    session_id: session.sessionId,
    raw_duration_minutes: result.rawDurationMinutes,
    credited_minutes: result.creditedMinutes,
    anti_farming_reason: result.antiFarmingReason,
    recovered,
    counted: result.counted,
  });

  return result;
}

module.exports = {
  name: 'voiceStateUpdate',

  async execute(oldState, newState) {
    const userId = newState.id || oldState.id;
    const guildId = newState.guild?.id || oldState.guild?.id;
    const member = newState.member || oldState.member;

    if (member?.user?.bot) return;
    if (!(await isSetup(guildId))) return;

    try {
      await syncVoicePresenceFromStateChange(oldState, newState);
    } catch (error) {
      logger.error('voice_presence_sync_failed', {
        guild_id: guildId,
        user_id: userId,
        old_channel_id: oldState.channelId,
        new_channel_id: newState.channelId,
        error,
      });
    }

    try {
      await syncSessionCandidatesFromStateChange(oldState, newState);
    } catch (error) {
      logger.error('session_candidate_sync_failed', {
        guild_id: guildId,
        user_id: userId,
        old_channel_id: oldState.channelId,
        new_channel_id: newState.channelId,
        error,
      });
    }

    try {
      const oldTrackable = isTrackableVoiceChannel(oldState.guild, oldState.channelId);
      const newTrackable = isTrackableVoiceChannel(newState.guild, newState.channelId);

      if (!oldTrackable && newTrackable) {
        await startVcSession({
          userId,
          guildId,
          channelId: newState.channelId,
          joinedAt: new Date(),
          member,
        });
        await markChannelHasCompanions(newState.guild, newState.channelId);
        return;
      }

      if (oldTrackable && !newTrackable) {
        await closeVcSession({
          guild: oldState.guild,
          userId,
          guildId,
          member,
          leftAt: new Date(),
        });
        return;
      }

      if (oldTrackable && newTrackable && oldState.channelId !== newState.channelId) {
        const key = buildActiveKey(userId, guildId);
        const session = active.get(key);

        if (session) {
          active.set(key, { ...session, channelId: newState.channelId });
          const { error: updateError } = await supabase
            .from('vc_sessions')
            .update({ channel_id: newState.channelId })
            .eq('id', session.sessionId);

          if (updateError) throw updateError;
        }

        await markChannelHasCompanions(newState.guild, newState.channelId);
      }
    } catch (error) {
      logger.error('voice_state_update_failed', {
        guild_id: guildId,
        user_id: userId,
        old_channel_id: oldState.channelId,
        new_channel_id: newState.channelId,
        error,
      });
    }
  },
};

async function announceBadge(guild, username, newBadgeIds, stats) {
  try {
    const config = await getGuildConfig(guild.id);
    if (!config?.announce_channel_id) return;

    const channel = guild.channels.cache.get(config.announce_channel_id);
    if (!channel) return;

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setTitle('🏅 New Badge Unlocked!')
          .setDescription(`**${username}** just earned a new badge!`)
          .addFields(
            { name: 'Badge', value: formatBadges(newBadgeIds), inline: true },
            { name: 'Total Sessions', value: `${stats.total_events}`, inline: true },
            { name: 'Streak', value: `${stats.current_streak} 🔥`, inline: true },
          )
          .setFooter({ text: 'GuildRank · Community Recognition' })
          .setTimestamp(),
      ],
    });
  } catch (error) {
    logger.error('badge_announce_failed', {
      guild_id: guild.id,
      username,
      error,
    });
  }
}

async function recoverOpenSessions(client) {
  const { data: openSessions, error } = await supabase
    .from('vc_sessions')
    .select('*')
    .is('left_at', null)
    .order('joined_at', { ascending: true });

  if (error) throw error;
  if (!openSessions?.length) return;

  const now = new Date();
  let resumedCount = 0;
  let closedCount = 0;
  const resumedChannels = new Set();

  for (const session of openSessions) {
    const guildIsSetup = await isSetup(session.guild_id);
    const guild = client.guilds.cache.get(session.guild_id);
    const voiceState = guild?.voiceStates?.cache.get(session.discord_id);
    const member = voiceState?.member || guild?.members.cache.get(session.discord_id) || null;
    const key = buildActiveKey(session.discord_id, session.guild_id);

    if (guildIsSetup && isTrackableVoiceChannel(guild, voiceState?.channelId)) {
      active.set(key, {
        sessionId: session.id,
        joinedAt: new Date(session.joined_at),
        guildId: session.guild_id,
        userId: session.discord_id,
        channelId: voiceState.channelId,
        hadCompanion: Boolean(session.had_companion),
        name: member?.user?.username || 'Unknown',
      });

      if (session.channel_id !== voiceState.channelId) {
        const { error: updateError } = await supabase
          .from('vc_sessions')
          .update({ channel_id: voiceState.channelId })
          .eq('id', session.id);

        if (updateError) throw updateError;
      }

      if (member) {
        await ensurePlayerProfile(buildProfile(member, session.guild_id));
      }

      resumedCount += 1;
      resumedChannels.add(`${session.guild_id}:${voiceState.channelId}`);
      continue;
    }

    await closeVcSession({
      guild,
      userId: session.discord_id,
      guildId: session.guild_id,
      member,
      leftAt: now,
      recovered: true,
    });

    closedCount += 1;
  }

  for (const entry of resumedChannels) {
    const [guildId, channelId] = entry.split(':');
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    await markChannelHasCompanions(guild, channelId);
  }

  logger.info('vc_recovery_completed', {
    resumed_sessions: resumedCount,
    closed_sessions: closedCount,
  });
}

module.exports.recoverOpenSessions = recoverOpenSessions;
