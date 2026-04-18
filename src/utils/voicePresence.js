const supabase = require('./supabase');
const logger = require('./logger');
const { getTrackedVoiceChannel, isTrackedVoiceChannelEnabled } = require('./trackedVoiceChannels');

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function getOpenVoicePresenceSegment(guildId, discordUserId) {
  const { data, error } = await supabase
    .from('voice_presence_segments')
    .select('*')
    .eq('guild_id', guildId)
    .eq('discord_user_id', discordUserId)
    .eq('segment_status', 'open')
    .order('joined_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function closeVoicePresenceSegment({ guildId, discordUserId, leftAt = new Date() }) {
  if (!guildId || !discordUserId) return null;

  const openSegment = await getOpenVoicePresenceSegment(guildId, discordUserId);
  if (!openSegment) return null;

  const joinedAt = new Date(openSegment.joined_at);
  const closedAt = leftAt instanceof Date ? leftAt : new Date(leftAt);
  const durationSeconds = Math.max(0, Math.floor((closedAt - joinedAt) / 1000));

  const { data, error } = await supabase
    .from('voice_presence_segments')
    .update({
      left_at: closedAt.toISOString(),
      duration_seconds: durationSeconds,
      segment_status: 'closed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', openSegment.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function openVoicePresenceSegment({
  guildId,
  channelId,
  discordUserId,
  trackedVoiceChannelId,
  joinedAt = new Date(),
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!channelId) throw new Error('channelId is required.');
  if (!discordUserId) throw new Error('discordUserId is required.');
  if (!trackedVoiceChannelId) throw new Error('trackedVoiceChannelId is required.');

  const openSegment = await getOpenVoicePresenceSegment(guildId, discordUserId);
  if (openSegment?.channel_id === channelId) {
    return openSegment;
  }

  if (openSegment) {
    await closeVoicePresenceSegment({ guildId, discordUserId, leftAt: joinedAt });
  }

  const payload = {
    guild_id: guildId,
    channel_id: channelId,
    tracked_voice_channel_id: trackedVoiceChannelId,
    discord_user_id: discordUserId,
    joined_at: toIsoString(joinedAt),
    segment_status: 'open',
    left_at: null,
    duration_seconds: null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('voice_presence_segments')
    .insert(payload)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return getOpenVoicePresenceSegment(guildId, discordUserId);
    }
    throw error;
  }

  return data;
}

async function resolveTrackedVoiceConfig(guildId, channelId) {
  if (!guildId || !channelId) return null;
  const row = await getTrackedVoiceChannel(guildId, channelId, { useCache: false });
  return isTrackedVoiceChannelEnabled(row) ? row : null;
}

async function closeOpenVoicePresenceSegmentsForChannel({
  guildId,
  channelId,
  leftAt = new Date(),
}) {
  if (!guildId || !channelId) return [];

  const { data: openSegments, error } = await supabase
    .from('voice_presence_segments')
    .select('discord_user_id')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .eq('segment_status', 'open');

  if (error) throw error;
  if (!openSegments?.length) return [];

  const closedSegments = [];
  for (const segment of openSegments) {
    const closed = await closeVoicePresenceSegment({
      guildId,
      discordUserId: segment.discord_user_id,
      leftAt,
    });

    if (closed) closedSegments.push(closed);
  }

  return closedSegments;
}

async function syncVoicePresenceFromStateChange(oldState, newState) {
  const guildId = newState.guild?.id || oldState.guild?.id;
  const discordUserId = newState.id || oldState.id;
  if (!guildId || !discordUserId) return { action: 'noop' };

  const oldChannelId = oldState.channelId || null;
  const newChannelId = newState.channelId || null;

  if (oldChannelId === newChannelId) {
    return { action: 'noop' };
  }

  const [oldTracked, newTracked] = await Promise.all([
    resolveTrackedVoiceConfig(guildId, oldChannelId),
    resolveTrackedVoiceConfig(guildId, newChannelId),
  ]);

  const timestamp = new Date();
  const actions = [];

  if (oldTracked) {
    const closedSegment = await closeVoicePresenceSegment({
      guildId,
      discordUserId,
      leftAt: timestamp,
    });

    if (closedSegment) {
      actions.push({ type: 'closed', segmentId: closedSegment.id, channelId: oldChannelId });
    }
  }

  if (newTracked) {
    const openedSegment = await openVoicePresenceSegment({
      guildId,
      channelId: newChannelId,
      discordUserId,
      trackedVoiceChannelId: newTracked.id,
      joinedAt: timestamp,
    });

    actions.push({
      type: 'opened',
      segmentId: openedSegment?.id || null,
      channelId: newChannelId,
      trackedVoiceChannelId: newTracked.id,
    });
  }

  if (!actions.length) {
    return { action: 'noop' };
  }

  logger.info('voice_presence_synced', {
    guild_id: guildId,
    discord_user_id: discordUserId,
    old_channel_id: oldChannelId,
    new_channel_id: newChannelId,
    actions,
  });

  return { action: 'updated', actions };
}

module.exports = {
  closeOpenVoicePresenceSegmentsForChannel,
  closeVoicePresenceSegment,
  getOpenVoicePresenceSegment,
  openVoicePresenceSegment,
  syncVoicePresenceFromStateChange,
};
