const supabase = require('./supabase');
const { calculateBadges, getNewBadges } = require('./badges');
const logger = require('./logger');
const { buildVcCreditDecision } = require('./vcCredit');
const { enqueueStatsRepair } = require('./repairs');
const { recalculateAllStats } = require('../jobs/recalcStats');
const {
  ACTIVE_STREAK_MAX_DAY_DIFF,
} = require('../../config/constants');

function toDayString(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

function diffDayStrings(later, earlier) {
  const laterDate = new Date(`${later}T00:00:00.000Z`);
  const earlierDate = new Date(`${earlier}T00:00:00.000Z`);
  return Math.round((laterDate - earlierDate) / 86400000);
}

function uniqueIds(ids = []) {
  return [...new Set(ids.filter(Boolean))];
}

function normalizeStats(row = {}) {
  return {
    discord_id: row.discord_id,
    guild_id: row.guild_id,
    total_events: row.total_events || 0,
    total_vc_sessions: row.total_vc_sessions || 0,
    total_manual_sessions: row.total_manual_sessions || 0,
    total_vc_minutes: row.total_vc_minutes || 0,
    wins: row.wins || 0,
    mvps: row.mvps || 0,
    current_streak: row.current_streak || 0,
    longest_streak: row.longest_streak || 0,
    last_seen: row.last_seen || null,
    last_seen_date: row.last_seen_date || null,
    badges: row.badges || [],
  };
}

function buildBadgeSnapshot(stats) {
  return {
    total_events: stats.total_events,
    total_vc_minutes: stats.total_vc_minutes,
    longest_streak: stats.longest_streak,
  };
}

function computeNextStreak(current, activityDate) {
  const currentStreak = current.current_streak || 0;
  const longestStreak = current.longest_streak || 0;
  const lastSeenDate = current.last_seen_date || null;

  if (!lastSeenDate) {
    return { currentStreak: 1, longestStreak: Math.max(longestStreak, 1) };
  }

  if (activityDate <= lastSeenDate) {
    return { currentStreak, longestStreak };
  }

  const diffDays = diffDayStrings(activityDate, lastSeenDate);
  const nextCurrentStreak = diffDays <= ACTIVE_STREAK_MAX_DAY_DIFF ? currentStreak + 1 : 1;

  return {
    currentStreak: nextCurrentStreak,
    longestStreak: Math.max(longestStreak, nextCurrentStreak),
  };
}

function buildProfilePayload(profile) {
  if (!profile?.discordId || !profile?.guildId) return null;

  return {
    discord_id: profile.discordId,
    guild_id: profile.guildId,
    username: profile.username || null,
    avatar_url: profile.avatarUrl || null,
    updated_at: new Date().toISOString(),
  };
}

async function ensurePlayerProfile(profile) {
  const payload = buildProfilePayload(profile);
  if (!payload) return;

  const { error } = await supabase
    .from('players')
    .upsert(payload, { onConflict: 'discord_id,guild_id' });

  if (error) throw error;
}

async function getPlayerStatsRecord(discordId, guildId) {
  const { data } = await supabase
    .from('player_stats')
    .select('*')
    .eq('discord_id', discordId)
    .eq('guild_id', guildId)
    .maybeSingle();

  return data ? normalizeStats(data) : null;
}

async function applyStatsDelta({
  discordId,
  guildId,
  activityAt = new Date(),
  sessionIncrement = 0,
  vcSessionIncrement = 0,
  manualSessionIncrement = 0,
  vcMinutesIncrement = 0,
  winsIncrement = 0,
  mvpsIncrement = 0,
  profile,
}) {
  const hasStatChange = [
    sessionIncrement,
    vcSessionIncrement,
    manualSessionIncrement,
    vcMinutesIncrement,
    winsIncrement,
    mvpsIncrement,
  ].some(value => value > 0);

  if (profile) {
    await ensurePlayerProfile(profile);
  }

  if (!hasStatChange) return null;

  const current = (await getPlayerStatsRecord(discordId, guildId)) || normalizeStats({ discord_id: discordId, guild_id: guildId });
  const activityDate = toDayString(activityAt);
  const streakState = sessionIncrement > 0
    ? computeNextStreak(current, activityDate)
    : { currentStreak: current.current_streak, longestStreak: current.longest_streak };

  const previousLastSeen = current.last_seen ? new Date(current.last_seen) : null;
  const currentActivityAt = new Date(activityAt);
  const keepPreviousLastSeen = previousLastSeen && previousLastSeen > currentActivityAt;

  const totalEvents = current.total_events + sessionIncrement;
  const totalVcSessions = current.total_vc_sessions + vcSessionIncrement;
  const totalManualSessions = current.total_manual_sessions + manualSessionIncrement;
  const totalVcMinutes = current.total_vc_minutes + vcMinutesIncrement;
  const wins = current.wins + winsIncrement;
  const mvps = current.mvps + mvpsIncrement;
  const lastSeen = keepPreviousLastSeen ? current.last_seen : currentActivityAt.toISOString();
  const lastSeenDate = keepPreviousLastSeen ? current.last_seen_date : activityDate;

  const nextStats = {
    discord_id: discordId,
    guild_id: guildId,
    total_events: totalEvents,
    total_vc_sessions: totalVcSessions,
    total_manual_sessions: totalManualSessions,
    total_vc_minutes: totalVcMinutes,
    wins,
    mvps,
    current_streak: streakState.currentStreak,
    longest_streak: streakState.longestStreak,
    last_seen: lastSeen,
    last_seen_date: lastSeenDate,
    badges: [],
    updated_at: new Date().toISOString(),
  };

  nextStats.badges = calculateBadges(buildBadgeSnapshot(nextStats));
  const newBadges = getNewBadges(current.badges, nextStats.badges);

  const { error } = await supabase
    .from('player_stats')
    .upsert(nextStats, { onConflict: 'discord_id,guild_id' });

  if (error) throw error;

  return { ...nextStats, newBadges };
}

async function hydrateStatsRows(guildId, rows = []) {
  if (!rows.length) return [];

  const ids = uniqueIds(rows.map(row => row.discord_id));
  const { data: players, error } = await supabase
    .from('players')
    .select('discord_id, guild_id, username, avatar_url')
    .eq('guild_id', guildId)
    .in('discord_id', ids);

  if (error) throw error;

  const playerMap = new Map(
    (players || []).map(player => [`${player.guild_id}:${player.discord_id}`, player])
  );

  return rows.map(row => {
    const normalized = normalizeStats(row);
    const player = playerMap.get(`${guildId}:${row.discord_id}`) || null;
    return { ...normalized, player, players: player };
  });
}

async function getLeaderboard(guildId, metric = 'total_events', limit = 10) {
  const { data } = await supabase
    .from('player_stats')
    .select('*')
    .eq('guild_id', guildId)
    .order(metric, { ascending: false })
    .order('last_seen', { ascending: false, nullsFirst: false })
    .limit(limit);

  return hydrateStatsRows(guildId, data || []);
}

async function getPlayerStats(discordId, guildId) {
  return getPlayerStatsRecord(discordId, guildId);
}

async function fetchGuildUserProfile(guild, userId) {
  try {
    const cachedMember = guild.members.cache.get(userId);
    const member = cachedMember || await guild.members.fetch(userId);
    return {
      discordId: userId,
      guildId: guild.id,
      username: member.user.username,
      avatarUrl: member.user.displayAvatarURL(),
      isBot: member.user.bot,
      isMember: true,
    };
  } catch {
    return {
      discordId: userId,
      guildId: guild.id,
      username: null,
      avatarUrl: null,
      isBot: false,
      isMember: false,
    };
  }
}

async function fetchGuildUserProfiles(guild, userIds = []) {
  const profiles = await Promise.all(userIds.map(userId => fetchGuildUserProfile(guild, userId)));
  return new Map(profiles.map(profile => [profile.discordId, profile]));
}

async function recordManualSession({
  requestId,
  guild,
  gameType,
  sessionType,
  attendeeIds,
  winnerId = null,
  mvpId = null,
  notes = '',
  loggedBy = null,
}) {
  const explicitAttendees = uniqueIds(attendeeIds);
  const participantIds = uniqueIds([...explicitAttendees, winnerId, mvpId]);

  if (!participantIds.length) {
    throw new Error('At least one participant is required.');
  }

  const profiles = await fetchGuildUserProfiles(guild, participantIds);
  const invalidParticipantIds = participantIds.filter(id => !profiles.get(id)?.isMember);
  if (invalidParticipantIds.length) {
    throw new Error(`These users are not members of this server: ${invalidParticipantIds.map(id => `<@${id}>`).join(', ')}`);
  }

  const filteredParticipantIds = participantIds.filter(id => !profiles.get(id)?.isBot);

  if (!filteredParticipantIds.length) {
    throw new Error('Only non-bot participants can be logged.');
  }

  const filteredAttendees = explicitAttendees.filter(id => filteredParticipantIds.includes(id));
  const effectiveWinnerId = filteredParticipantIds.includes(winnerId) ? winnerId : null;
  const effectiveMvpId = filteredParticipantIds.includes(mvpId) ? mvpId : null;
  const occurredAt = new Date();

  for (const participantId of filteredParticipantIds) {
    await ensurePlayerProfile(profiles.get(participantId));
  }

  if (!requestId) {
    throw new Error('requestId is required for idempotent manual session logging.');
  }

  const { data: rpcRows, error: rpcError } = await supabase.rpc('log_manual_session', {
    p_request_id: requestId,
    p_guild_id: guild.id,
    p_game_type: gameType,
    p_session_type: sessionType,
    p_winner_id: effectiveWinnerId,
    p_mvp_id: effectiveMvpId,
    p_notes: notes || null,
    p_logged_by: loggedBy,
    p_participant_ids: filteredParticipantIds,
  });

  if (rpcError) throw rpcError;

  const rpcRow = rpcRows?.[0];
  if (!rpcRow?.event_id) {
    throw new Error('Manual session log failed: database did not return an event ID.');
  }

  let statsRebuilt = false;
  try {
    await recalculateAllStats({ guildId: guild.id, reason: 'manual_session_log', requestId });
    statsRebuilt = true;
  } catch (error) {
    await enqueueStatsRepair({
      guildId: guild.id,
      requestId,
      requestedBy: loggedBy,
      reason: error.message || 'manual_session_recalc_failed',
      metadata: { event_id: rpcRow.event_id, source: 'manual_session_log' },
    }).catch(enqueueError => {
      logger.error('manual_session_repair_enqueue_failed', {
        guild_id: guild.id,
        request_id: requestId,
        event_id: rpcRow.event_id,
        error: enqueueError,
      });
    });

    logger.error('manual_session_recalc_failed', {
      guild_id: guild.id,
      request_id: requestId,
      event_id: rpcRow.event_id,
      session_type: sessionType,
      error,
    });
  }

  return {
    event: {
      id: rpcRow.event_id,
      started_at: rpcRow.started_at || occurredAt.toISOString(),
    },
    occurredAt: rpcRow.started_at || occurredAt.toISOString(),
    participantIds: filteredParticipantIds,
    explicitAttendeeIds: filteredAttendees,
    autoIncludedIds: filteredParticipantIds.filter(id => !filteredAttendees.includes(id)),
    winnerId: effectiveWinnerId,
    mvpId: effectiveMvpId,
    duplicate: rpcRow.created === false,
    statsRebuilt,
  };
}

async function getManualEventSnapshot(guildId, eventId) {
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('*')
    .eq('id', eventId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (eventError) throw eventError;
  if (!event) return null;

  const { data: attendance, error: attendanceError } = await supabase
    .from('event_attendance')
    .select('discord_id')
    .eq('event_id', eventId)
    .eq('guild_id', guildId);

  if (attendanceError) throw attendanceError;

  return {
    ...event,
    participant_ids: uniqueIds((attendance || []).map(row => row.discord_id)),
  };
}

async function voidManualSession({
  requestId,
  guildId,
  eventId,
  actorDiscordId,
  reason,
}) {
  const before = await getManualEventSnapshot(guildId, eventId);
  if (!before) {
    throw new Error('Manual session not found in this server.');
  }

  const { data: rpcRows, error: rpcError } = await supabase.rpc('void_manual_session_event', {
    p_request_id: requestId,
    p_guild_id: guildId,
    p_event_id: eventId,
    p_actor_discord_id: actorDiscordId,
    p_reason: reason,
  });

  if (rpcError) {
    if ((rpcError.message || '').includes('event_not_found')) {
      throw new Error('Manual session not found in this server.');
    }
    throw rpcError;
  }

  const rpcRow = rpcRows?.[0];
  if (!rpcRow?.event_id) {
    throw new Error('Correction failed: database did not confirm the session update.');
  }

  const alreadyVoided = Boolean(rpcRow.already_voided);

  let statsRebuilt = false;
  try {
    await recalculateAllStats({
      guildId,
      reason: alreadyVoided ? 'manual_session_void_reconcile' : 'manual_session_void',
      requestId,
    });
    statsRebuilt = true;
  } catch (rebuildError) {
    await enqueueStatsRepair({
      guildId,
      requestId,
      requestedBy: actorDiscordId,
      reason: rebuildError.message || 'manual_session_void_recalc_failed',
      metadata: {
        event_id: eventId,
        source: alreadyVoided ? 'manual_session_void_reconcile' : 'manual_session_void',
      },
    }).catch(enqueueError => {
      logger.error('manual_session_void_repair_enqueue_failed', {
        guild_id: guildId,
        request_id: requestId,
        event_id: eventId,
        error: enqueueError,
      });
    });

    logger.error('manual_session_void_recalc_failed', {
      guild_id: guildId,
      request_id: requestId,
      event_id: eventId,
      error: rebuildError,
    });
  }

  return {
    eventId,
    alreadyVoided,
    statsRebuilt,
    before,
  };
}

async function finalizeVcSession({
  sessionId,
  discordId,
  guildId,
  durationMinutes,
  hadCompanion = false,
  leftAt = new Date(),
  recovered = false,
  profile,
}) {
  const creditDecision = buildVcCreditDecision(durationMinutes, hadCompanion);
  const { data: updatedRow, error } = await supabase
    .from('vc_sessions')
    .update({
      left_at: new Date(leftAt).toISOString(),
      duration_minutes: creditDecision.creditedMinutes,
      raw_duration_minutes: creditDecision.rawDurationMinutes,
      credited_minutes: creditDecision.creditedMinutes,
      had_companion: hadCompanion,
      anti_farming_reason: creditDecision.antiFarmingReason,
      recovered,
    })
    .eq('id', sessionId)
    .is('left_at', null)
    .select('id')
    .maybeSingle();

  if (error) throw error;
  if (!updatedRow) {
    return {
      counted: false,
      durationMinutes: creditDecision.creditedMinutes,
      rawDurationMinutes: creditDecision.rawDurationMinutes,
      creditedMinutes: creditDecision.creditedMinutes,
      antiFarmingReason: creditDecision.antiFarmingReason,
      stats: null,
      duplicate: true,
    };
  }

  if (creditDecision.creditedMinutes <= 0) {
    return {
      counted: false,
      durationMinutes: creditDecision.creditedMinutes,
      rawDurationMinutes: creditDecision.rawDurationMinutes,
      creditedMinutes: creditDecision.creditedMinutes,
      antiFarmingReason: creditDecision.antiFarmingReason,
      stats: null,
    };
  }

  const stats = await applyStatsDelta({
    discordId,
    guildId,
    activityAt: leftAt,
    sessionIncrement: 1,
    vcSessionIncrement: 1,
    vcMinutesIncrement: creditDecision.creditedMinutes,
    profile,
  });

  return {
    counted: true,
    durationMinutes: creditDecision.creditedMinutes,
    rawDurationMinutes: creditDecision.rawDurationMinutes,
    creditedMinutes: creditDecision.creditedMinutes,
    antiFarmingReason: creditDecision.antiFarmingReason,
    stats,
  };
}

module.exports = {
  ensurePlayerProfile,
  applyStatsDelta,
  finalizeVcSession,
  recordManualSession,
  voidManualSession,
  getLeaderboard,
  getPlayerStats,
  hydrateStatsRows,
  normalizeStats,
  toDayString,
  diffDayStrings,
  buildVcCreditDecision,
};
