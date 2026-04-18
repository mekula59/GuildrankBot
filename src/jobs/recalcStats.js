const supabase = require('../utils/supabase');
const { calculateBadges } = require('../utils/badges');
const logger = require('../utils/logger');
const { completeStatsRepair, completeAllStatsRepairs } = require('../utils/repairs');
const { ACTIVE_STREAK_MAX_DAY_DIFF } = require('../../config/constants');

function buildKey(discordId, guildId) {
  return `${guildId}:${discordId}`;
}

function toDayString(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function diffDayStrings(later, earlier) {
  const laterDate = new Date(`${later}T00:00:00.000Z`);
  const earlierDate = new Date(`${earlier}T00:00:00.000Z`);
  return Math.round((laterDate - earlierDate) / 86400000);
}

function getBucket(map, discordId, guildId) {
  const key = buildKey(discordId, guildId);
  if (!map.has(key)) {
    map.set(key, {
      discord_id: discordId,
      guild_id: guildId,
      total_events: 0,
      total_vc_sessions: 0,
      total_manual_sessions: 0,
      total_vc_minutes: 0,
      wins: 0,
      mvps: 0,
      last_seen: null,
      activityDays: new Set(),
    });
  }

  return map.get(key);
}

function markActivity(bucket, timestamp) {
  if (!timestamp) return;

  bucket.activityDays.add(toDayString(timestamp));

  if (!bucket.last_seen || new Date(timestamp) > new Date(bucket.last_seen)) {
    bucket.last_seen = new Date(timestamp).toISOString();
  }
}

function computeStreaks(activityDays) {
  const sortedDays = [...activityDays].sort();
  if (!sortedDays.length) {
    return { currentStreak: 0, longestStreak: 0, lastSeenDate: null };
  }

  let longestStreak = 1;
  let runningStreak = 1;

  for (let index = 1; index < sortedDays.length; index += 1) {
    const gap = diffDayStrings(sortedDays[index], sortedDays[index - 1]);
    runningStreak = gap <= ACTIVE_STREAK_MAX_DAY_DIFF ? runningStreak + 1 : 1;
    longestStreak = Math.max(longestStreak, runningStreak);
  }

  let currentStreak = 1;
  for (let index = sortedDays.length - 1; index > 0; index -= 1) {
    const gap = diffDayStrings(sortedDays[index], sortedDays[index - 1]);
    if (gap > ACTIVE_STREAK_MAX_DAY_DIFF) break;
    currentStreak += 1;
  }

  const today = toDayString(new Date());
  const lastSeenDate = sortedDays[sortedDays.length - 1];
  if (diffDayStrings(today, lastSeenDate) > ACTIVE_STREAK_MAX_DAY_DIFF) {
    currentStreak = 0;
  }

  return { currentStreak, longestStreak, lastSeenDate };
}

async function deleteStaleRows(validKeys, guildId = null) {
  let query = supabase
    .from('player_stats')
    .select('discord_id, guild_id');

  if (guildId) {
    query = query.eq('guild_id', guildId);
  }

  const { data: existingRows, error } = await query;

  if (error) throw error;

  for (const row of existingRows || []) {
    if (validKeys.has(buildKey(row.discord_id, row.guild_id))) continue;

    const { error: deleteError } = await supabase
      .from('player_stats')
      .delete()
      .eq('discord_id', row.discord_id)
      .eq('guild_id', row.guild_id);

    if (deleteError) throw deleteError;
  }
}

async function upsertRows(rows) {
  const chunkSize = 250;

  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const { error } = await supabase
      .from('player_stats')
      .upsert(chunk, { onConflict: 'discord_id,guild_id' });

    if (error) throw error;
  }
}

async function recalculateAllStats({ guildId = null, reason = 'scheduled_recalc', requestId = null } = {}) {
  const vcQuery = supabase
    .from('vc_sessions')
    .select('discord_id, guild_id, credited_minutes, left_at')
    .not('left_at', 'is', null)
    .gt('credited_minutes', 0);

  const eventsQuery = supabase
    .from('events')
    .select('id, guild_id, winner_id, mvp_id, started_at')
    .is('voided_at', null);

  const attendanceQuery = supabase
    .from('event_attendance')
    .select('event_id, discord_id, guild_id');

  if (guildId) {
    vcQuery.eq('guild_id', guildId);
    eventsQuery.eq('guild_id', guildId);
    attendanceQuery.eq('guild_id', guildId);
  }

  const [
    vcResponse,
    eventsResponse,
    attendanceResponse,
  ] = await Promise.all([
    vcQuery,
    eventsQuery,
    attendanceQuery,
  ]);

  if (vcResponse.error) throw vcResponse.error;
  if (eventsResponse.error) throw eventsResponse.error;
  if (attendanceResponse.error) throw attendanceResponse.error;

  logger.info('stats_recalc_started', {
    guild_id: guildId,
    reason,
    request_id: requestId,
    vc_session_rows: vcResponse.data?.length || 0,
    event_rows: eventsResponse.data?.length || 0,
    attendance_rows: attendanceResponse.data?.length || 0,
  });

  const statsMap = new Map();
  const attendanceByEvent = new Map();

  for (const row of attendanceResponse.data || []) {
    const eventAttendance = attendanceByEvent.get(row.event_id) || new Set();
    eventAttendance.add(row.discord_id);
    attendanceByEvent.set(row.event_id, eventAttendance);
  }

  for (const session of vcResponse.data || []) {
    const bucket = getBucket(statsMap, session.discord_id, session.guild_id);
    bucket.total_events += 1;
    bucket.total_vc_sessions += 1;
    bucket.total_vc_minutes += session.credited_minutes || 0;
    markActivity(bucket, session.left_at);
  }

  for (const event of eventsResponse.data || []) {
    const participantIds = new Set(attendanceByEvent.get(event.id) || []);
    if (event.winner_id) participantIds.add(event.winner_id);
    if (event.mvp_id) participantIds.add(event.mvp_id);

    for (const participantId of participantIds) {
      const bucket = getBucket(statsMap, participantId, event.guild_id);
      bucket.total_events += 1;
      bucket.total_manual_sessions += 1;
      markActivity(bucket, event.started_at);

      if (participantId === event.winner_id) {
        bucket.wins += 1;
      }

      if (participantId === event.mvp_id) {
        bucket.mvps += 1;
      }
    }
  }

  const rows = [...statsMap.values()].map(bucket => {
    const streaks = computeStreaks(bucket.activityDays);
    const row = {
      discord_id: bucket.discord_id,
      guild_id: bucket.guild_id,
      total_events: bucket.total_events,
      total_vc_sessions: bucket.total_vc_sessions,
      total_manual_sessions: bucket.total_manual_sessions,
      total_vc_minutes: bucket.total_vc_minutes,
      wins: bucket.wins,
      mvps: bucket.mvps,
      current_streak: streaks.currentStreak,
      longest_streak: streaks.longestStreak,
      last_seen: bucket.last_seen,
      last_seen_date: streaks.lastSeenDate,
      updated_at: new Date().toISOString(),
    };

    row.badges = calculateBadges(row);
    return row;
  });

  await deleteStaleRows(new Set(rows.map(row => buildKey(row.discord_id, row.guild_id))), guildId);

  if (rows.length) {
    await upsertRows(rows);
  }

  if (guildId) {
    await completeStatsRepair(guildId);
  } else {
    await completeAllStatsRepairs();
  }

  logger.info('stats_recalc_completed', {
    guild_id: guildId,
    reason,
    request_id: requestId,
    rebuilt_rows: rows.length,
  });
}

module.exports = { recalculateAllStats };
