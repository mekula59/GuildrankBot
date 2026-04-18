const supabase = require('./supabase');
const { writeAuditLog } = require('./audit');

const byGuildCache = new Map();
const byGuildChannelCache = new Map();

function normalizeTrackedVoiceChannel(row = {}) {
  return {
    id: row.id,
    guild_id: row.guild_id,
    channel_id: row.channel_id,
    channel_name_snapshot: row.channel_name_snapshot,
    game_key: row.game_key,
    session_type: row.session_type,
    tracking_enabled: row.tracking_enabled !== false,
    ignore_for_candidates: Boolean(row.ignore_for_candidates),
    is_afk_channel: Boolean(row.is_afk_channel),
    min_active_members: row.min_active_members ?? 2,
    min_candidate_duration_minutes: row.min_candidate_duration_minutes ?? 10,
    min_participant_presence_minutes: row.min_participant_presence_minutes ?? 5,
    grace_gap_seconds: row.grace_gap_seconds ?? 180,
    auto_close_after_idle_minutes: row.auto_close_after_idle_minutes ?? 10,
    created_by_discord_user_id: row.created_by_discord_user_id,
    updated_by_discord_user_id: row.updated_by_discord_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildChannelCacheKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function invalidateTrackedVoiceChannelCache(guildId, channelId = null) {
  if (guildId) byGuildCache.delete(guildId);
  if (guildId && channelId) {
    byGuildChannelCache.delete(buildChannelCacheKey(guildId, channelId));
  } else if (guildId) {
    for (const key of byGuildChannelCache.keys()) {
      if (key.startsWith(`${guildId}:`)) byGuildChannelCache.delete(key);
    }
  }
}

function validateThreshold(name, value, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
}

function assertTrackedVoiceChannelInput(input = {}) {
  if (!input.guildId) throw new Error('guildId is required.');
  if (!input.channelId) throw new Error('channelId is required.');
  if (!input.channelNameSnapshot) throw new Error('channelNameSnapshot is required.');
  if (!input.gameKey) throw new Error('gameKey is required.');
  if (!input.sessionType) throw new Error('sessionType is required.');

  validateThreshold('minActiveMembers', input.minActiveMembers ?? 2, 2);
  validateThreshold('minCandidateDurationMinutes', input.minCandidateDurationMinutes ?? 10, 1);
  validateThreshold('minParticipantPresenceMinutes', input.minParticipantPresenceMinutes ?? 5, 1);
  validateThreshold('graceGapSeconds', input.graceGapSeconds ?? 180, 0);
  validateThreshold('autoCloseAfterIdleMinutes', input.autoCloseAfterIdleMinutes ?? 10, 1);
}

async function listTrackedVoiceChannels(guildId, { includeDisabled = true, useCache = true } = {}) {
  if (!guildId) throw new Error('guildId is required.');

  if (useCache && byGuildCache.has(guildId)) {
    const rows = byGuildCache.get(guildId);
    return includeDisabled ? rows : rows.filter(row => row.tracking_enabled);
  }

  const { data, error } = await supabase
    .from('tracked_voice_channels')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true });

  if (error) throw error;

  const rows = (data || []).map(normalizeTrackedVoiceChannel);
  byGuildCache.set(guildId, rows);
  for (const row of rows) {
    byGuildChannelCache.set(buildChannelCacheKey(guildId, row.channel_id), row);
  }

  return includeDisabled ? rows : rows.filter(row => row.tracking_enabled);
}

async function getTrackedVoiceChannel(guildId, channelId, { useCache = true } = {}) {
  if (!guildId || !channelId) return null;

  const cacheKey = buildChannelCacheKey(guildId, channelId);
  if (useCache && byGuildChannelCache.has(cacheKey)) {
    return byGuildChannelCache.get(cacheKey);
  }

  const { data, error } = await supabase
    .from('tracked_voice_channels')
    .select('*')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = normalizeTrackedVoiceChannel(data);
  byGuildChannelCache.set(cacheKey, row);
  return row;
}

async function upsertTrackedVoiceChannel({
  guildId,
  channelId,
  channelNameSnapshot,
  gameKey,
  sessionType,
  trackingEnabled = true,
  ignoreForCandidates = false,
  isAfkChannel = false,
  minActiveMembers = 2,
  minCandidateDurationMinutes = 10,
  minParticipantPresenceMinutes = 5,
  graceGapSeconds = 180,
  autoCloseAfterIdleMinutes = 10,
  actorDiscordId = null,
  requestId = null,
  reason = null,
}) {
  assertTrackedVoiceChannelInput({
    guildId,
    channelId,
    channelNameSnapshot,
    gameKey,
    sessionType,
    minActiveMembers,
    minCandidateDurationMinutes,
    minParticipantPresenceMinutes,
    graceGapSeconds,
    autoCloseAfterIdleMinutes,
  });

  const before = await getTrackedVoiceChannel(guildId, channelId, { useCache: false });
  const actorId = actorDiscordId || 'system';
  const payload = {
    guild_id: guildId,
    channel_id: channelId,
    channel_name_snapshot: channelNameSnapshot,
    game_key: gameKey,
    session_type: sessionType,
    tracking_enabled: trackingEnabled,
    ignore_for_candidates: ignoreForCandidates,
    is_afk_channel: isAfkChannel,
    min_active_members: minActiveMembers,
    min_candidate_duration_minutes: minCandidateDurationMinutes,
    min_participant_presence_minutes: minParticipantPresenceMinutes,
    grace_gap_seconds: graceGapSeconds,
    auto_close_after_idle_minutes: autoCloseAfterIdleMinutes,
    created_by_discord_user_id: before?.created_by_discord_user_id || actorId,
    updated_by_discord_user_id: actorId,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('tracked_voice_channels')
    .upsert(payload, { onConflict: 'guild_id,channel_id' })
    .select()
    .single();

  if (error) throw error;

  invalidateTrackedVoiceChannelCache(guildId, channelId);
  const normalized = normalizeTrackedVoiceChannel(data);
  byGuildChannelCache.set(buildChannelCacheKey(guildId, channelId), normalized);

  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: before ? 'vc_track_updated' : 'vc_track_enabled',
    targetType: 'tracked_voice_channel',
    targetId: normalized.id,
    requestId,
    reason,
    before,
    after: normalized,
    metadata: {
      guild_id: guildId,
      channel_id: channelId,
      game_key: gameKey,
      session_type: sessionType,
    },
  });

  return normalized;
}

async function disableTrackedVoiceChannel({
  guildId,
  channelId,
  actorDiscordId = null,
  requestId = null,
  reason = null,
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!channelId) throw new Error('channelId is required.');

  const before = await getTrackedVoiceChannel(guildId, channelId, { useCache: false });
  if (!before) return null;
  if (!before.tracking_enabled) return before;

  const { data, error } = await supabase
    .from('tracked_voice_channels')
    .update({
      tracking_enabled: false,
      updated_by_discord_user_id: actorDiscordId || 'system',
      updated_at: new Date().toISOString(),
    })
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .select()
    .single();

  if (error) throw error;

  invalidateTrackedVoiceChannelCache(guildId, channelId);
  const normalized = normalizeTrackedVoiceChannel(data);
  byGuildChannelCache.set(buildChannelCacheKey(guildId, channelId), normalized);

  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: 'vc_track_disabled',
    targetType: 'tracked_voice_channel',
    targetId: normalized.id,
    requestId,
    reason,
    before,
    after: normalized,
    metadata: {
      guild_id: guildId,
      channel_id: channelId,
      game_key: normalized.game_key,
      session_type: normalized.session_type,
    },
  });

  return normalized;
}

function isTrackedVoiceChannelEnabled(row) {
  return Boolean(row && row.tracking_enabled && !row.ignore_for_candidates && !row.is_afk_channel);
}

module.exports = {
  disableTrackedVoiceChannel,
  getTrackedVoiceChannel,
  invalidateTrackedVoiceChannelCache,
  isTrackedVoiceChannelEnabled,
  listTrackedVoiceChannels,
  normalizeTrackedVoiceChannel,
  upsertTrackedVoiceChannel,
};
