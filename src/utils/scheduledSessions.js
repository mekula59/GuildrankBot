const supabase = require('./supabase');
const { writeAuditLog } = require('./audit');
const {
  normalizeGameKey,
  normalizeTimezoneLabel,
  parseScheduledStartInput,
} = require('./scheduledSessionTime');
const { resolveScheduledSessionMatch } = require('./scheduledSessionMatch');
const {
  SCHEDULE_MATCH_BEFORE_START_MINUTES,
  SCHEDULE_MATCH_AFTER_START_MINUTES,
} = require('../../config/constants');

const SCHEDULE_STATUSES = ['scheduled', 'cancelled', 'completed'];

function normalizeScheduledSession(row = {}) {
  return {
    id: row.id,
    guild_id: row.guild_id,
    game_key: row.game_key,
    session_type: row.session_type,
    scheduled_start_at: row.scheduled_start_at,
    input_timezone: row.input_timezone,
    linked_channel_id: row.linked_channel_id,
    host_discord_user_id: row.host_discord_user_id,
    notes: row.notes,
    status: row.status,
    completed_event_id: row.completed_event_id,
    cancelled_at: row.cancelled_at,
    cancelled_by_discord_user_id: row.cancelled_by_discord_user_id,
    cancel_reason: row.cancel_reason,
    created_by_discord_user_id: row.created_by_discord_user_id,
    updated_by_discord_user_id: row.updated_by_discord_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeNotes(input) {
  if (input == null) return null;
  const normalized = String(input).trim();
  return normalized || null;
}

async function findMatchingScheduledSession({
  guildId,
  channelId = null,
  startedAt,
}) {
  if (!guildId) throw new Error('guildId is required.');

  const candidateStart = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(candidateStart.getTime())) {
    throw new Error('startedAt must be a valid date for schedule matching.');
  }

  const windowStart = new Date(candidateStart.getTime() - (SCHEDULE_MATCH_BEFORE_START_MINUTES * 60 * 1000)).toISOString();
  const windowEnd = new Date(candidateStart.getTime() + (SCHEDULE_MATCH_AFTER_START_MINUTES * 60 * 1000)).toISOString();

  const { data, error } = await supabase
    .from('scheduled_sessions')
    .select('*')
    .eq('guild_id', guildId)
    .eq('status', 'scheduled')
    .gte('scheduled_start_at', windowStart)
    .lte('scheduled_start_at', windowEnd)
    .order('scheduled_start_at', { ascending: true });

  if (error) throw error;

  const result = resolveScheduledSessionMatch(data || [], {
    channelId,
    startedAt: candidateStart,
  });

  return {
    ...result,
    scheduledSession: result.scheduledSession ? normalizeScheduledSession(result.scheduledSession) : null,
  };
}

async function getScheduledSessionsByIds(guildId, scheduledSessionIds = []) {
  const ids = [...new Set((scheduledSessionIds || []).filter(Boolean))];
  if (!guildId || !ids.length) return [];

  const { data, error } = await supabase
    .from('scheduled_sessions')
    .select('*')
    .eq('guild_id', guildId)
    .in('id', ids);

  if (error) throw error;
  return (data || []).map(normalizeScheduledSession);
}

async function getScheduledSessionById(guildId, scheduledSessionId) {
  if (!guildId || !scheduledSessionId) return null;

  const { data, error } = await supabase
    .from('scheduled_sessions')
    .select('*')
    .eq('guild_id', guildId)
    .eq('id', scheduledSessionId)
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeScheduledSession(data) : null;
}

async function createScheduledSession({
  guildId,
  gameKey,
  sessionType,
  startTimeInput,
  timezoneLabel = null,
  linkedChannelId = null,
  hostDiscordUserId = null,
  notes = null,
  actorDiscordId,
  requestId = null,
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!sessionType) throw new Error('sessionType is required.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required.');

  const payload = {
    guild_id: guildId,
    game_key: normalizeGameKey(gameKey),
    session_type: sessionType,
    scheduled_start_at: parseScheduledStartInput(startTimeInput),
    input_timezone: normalizeTimezoneLabel(timezoneLabel),
    linked_channel_id: linkedChannelId || null,
    host_discord_user_id: hostDiscordUserId || null,
    notes: normalizeNotes(notes),
    status: 'scheduled',
    created_by_discord_user_id: actorDiscordId,
    updated_by_discord_user_id: actorDiscordId,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('scheduled_sessions')
    .insert(payload)
    .select()
    .single();

  if (error) throw error;

  const normalized = normalizeScheduledSession(data);
  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: 'scheduled_session_created',
    targetType: 'scheduled_session',
    targetId: normalized.id,
    requestId,
    before: null,
    after: normalized,
    metadata: {
      guild_id: guildId,
      linked_channel_id: normalized.linked_channel_id,
      host_discord_user_id: normalized.host_discord_user_id,
      status: normalized.status,
    },
  });

  return normalized;
}

async function listUpcomingScheduledSessions(guildId, { limit = 10 } = {}) {
  if (!guildId) throw new Error('guildId is required.');

  const { data, error } = await supabase
    .from('scheduled_sessions')
    .select('*')
    .eq('guild_id', guildId)
    .eq('status', 'scheduled')
    .order('scheduled_start_at', { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 25));

  if (error) throw error;
  return (data || []).map(normalizeScheduledSession);
}

async function cancelScheduledSession({
  guildId,
  scheduledSessionId,
  actorDiscordId,
  reason = null,
  requestId = null,
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!scheduledSessionId) throw new Error('scheduledSessionId is required.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required.');

  const before = await getScheduledSessionById(guildId, scheduledSessionId);
  if (!before) {
    throw new Error('Scheduled session not found in this server.');
  }

  if (before.status === 'completed') {
    throw new Error('A completed scheduled session cannot be cancelled.');
  }

  if (before.status === 'cancelled') {
    return before;
  }

  const { data, error } = await supabase
    .from('scheduled_sessions')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancelled_by_discord_user_id: actorDiscordId,
      cancel_reason: normalizeNotes(reason),
      updated_by_discord_user_id: actorDiscordId,
      updated_at: new Date().toISOString(),
    })
    .eq('guild_id', guildId)
    .eq('id', scheduledSessionId)
    .eq('status', 'scheduled')
    .select()
    .single();

  if (error) throw error;

  const normalized = normalizeScheduledSession(data);
  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: 'scheduled_session_cancelled',
    targetType: 'scheduled_session',
    targetId: normalized.id,
    requestId,
    reason: normalizeNotes(reason),
    before,
    after: normalized,
    metadata: {
      guild_id: guildId,
      previous_status: before.status,
      next_status: normalized.status,
    },
  });

  return normalized;
}

async function rescheduleScheduledSession({
  guildId,
  scheduledSessionId,
  actorDiscordId,
  startTimeInput,
  timezoneLabel = null,
  linkedChannelId = undefined,
  hostDiscordUserId = undefined,
  notes = undefined,
  gameKey = undefined,
  sessionType = undefined,
  requestId = null,
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!scheduledSessionId) throw new Error('scheduledSessionId is required.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required.');
  if (!startTimeInput) throw new Error('start_time is required to reschedule.');

  const before = await getScheduledSessionById(guildId, scheduledSessionId);
  if (!before) {
    throw new Error('Scheduled session not found in this server.');
  }

  if (before.status === 'completed') {
    throw new Error('A completed scheduled session cannot be rescheduled.');
  }

  if (before.status === 'cancelled') {
    throw new Error('A cancelled scheduled session cannot be rescheduled.');
  }

  const payload = {
    scheduled_start_at: parseScheduledStartInput(startTimeInput),
    input_timezone: timezoneLabel === undefined ? before.input_timezone : normalizeTimezoneLabel(timezoneLabel),
    linked_channel_id: linkedChannelId === undefined ? before.linked_channel_id : (linkedChannelId || null),
    host_discord_user_id: hostDiscordUserId === undefined ? before.host_discord_user_id : (hostDiscordUserId || null),
    notes: notes === undefined ? before.notes : normalizeNotes(notes),
    game_key: gameKey === undefined ? before.game_key : normalizeGameKey(gameKey),
    session_type: sessionType === undefined ? before.session_type : sessionType,
    updated_by_discord_user_id: actorDiscordId,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('scheduled_sessions')
    .update(payload)
    .eq('guild_id', guildId)
    .eq('id', scheduledSessionId)
    .eq('status', 'scheduled')
    .select()
    .single();

  if (error) throw error;

  const normalized = normalizeScheduledSession(data);
  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: 'scheduled_session_rescheduled',
    targetType: 'scheduled_session',
    targetId: normalized.id,
    requestId,
    before,
    after: normalized,
    metadata: {
      guild_id: guildId,
      previous_start_at: before.scheduled_start_at,
      next_start_at: normalized.scheduled_start_at,
    },
  });

  return normalized;
}

module.exports = {
  SCHEDULE_STATUSES,
  cancelScheduledSession,
  createScheduledSession,
  findMatchingScheduledSession,
  getScheduledSessionById,
  getScheduledSessionsByIds,
  listUpcomingScheduledSessions,
  normalizeScheduledSession,
  resolveScheduledSessionMatch,
  rescheduleScheduledSession,
};
