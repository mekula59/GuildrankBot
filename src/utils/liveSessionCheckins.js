const supabase = require('./supabase');
const { writeAuditLog } = require('./audit');
const {
  getLiveSessionWithPeople,
  listLiveSessionPeople,
  normalizeLiveSession,
} = require('./liveSessions');
const { applyConfirmationToRoster } = require('./liveSessionRoster');

const CHECKIN_RESPONSES = ['playing', 'spectating', 'not_in_session'];

function normalizeConfirmation(row = {}) {
  if (!row) return null;

  return {
    id: row.id,
    guild_id: row.guild_id,
    live_session_id: row.live_session_id,
    discord_user_id: row.discord_user_id,
    response: row.response,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listLiveSessionConfirmations(guildId, liveSessionId) {
  if (!guildId) throw new Error('guildId is required.');
  if (!liveSessionId) throw new Error('liveSessionId is required.');

  const { data, error } = await supabase
    .from('live_session_confirmations')
    .select('*')
    .eq('guild_id', guildId)
    .eq('live_session_id', liveSessionId)
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return (data || []).map(normalizeConfirmation);
}

async function setLiveSessionCheckinStatus({
  guildId,
  liveSessionId,
  actorDiscordId,
  status,
  requestId = null,
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!liveSessionId) throw new Error('liveSessionId is required.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required.');
  if (!['open', 'closed'].includes(status)) throw new Error('Invalid check-in status.');

  const before = await getLiveSessionWithPeople(guildId, liveSessionId);
  if (!before.liveSession) {
    throw new Error('Live session not found in this server.');
  }
  if (before.liveSession.status !== 'live') {
    throw new Error('Check-in is only available while the live session is running.');
  }

  const timestamp = new Date().toISOString();
  const patch = {
    checkin_status: status,
    updated_by_discord_user_id: actorDiscordId,
    updated_at: timestamp,
  };

  if (status === 'open') {
    patch.checkin_opened_at = timestamp;
    patch.checkin_closed_at = null;
  } else {
    patch.checkin_closed_at = timestamp;
  }

  const { data, error } = await supabase
    .from('live_sessions')
    .update(patch)
    .eq('id', liveSessionId)
    .eq('guild_id', guildId)
    .eq('status', 'live')
    .select()
    .single();

  if (error) throw error;

  const after = {
    liveSession: normalizeLiveSession(data),
    people: before.people,
  };

  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: status === 'open' ? 'live_session_checkin_opened' : 'live_session_checkin_closed',
    targetType: 'live_session',
    targetId: liveSessionId,
    requestId,
    before: before.liveSession,
    after: after.liveSession,
    metadata: {
      guild_id: guildId,
      live_session_id: liveSessionId,
      checkin_status: status,
    },
  });

  return after;
}

async function recordLiveSessionConfirmation({
  guildId,
  liveSessionId,
  discordUserId,
  response,
  source = 'button',
  requestId = null,
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!liveSessionId) throw new Error('liveSessionId is required.');
  if (!discordUserId) throw new Error('discordUserId is required.');
  if (!CHECKIN_RESPONSES.includes(response)) throw new Error('Invalid check-in response.');
  if (!['button', 'operator'].includes(source)) throw new Error('Invalid check-in source.');

  const before = await getLiveSessionWithPeople(guildId, liveSessionId);
  if (!before.liveSession) {
    throw new Error('Live session not found in this server.');
  }
  if (before.liveSession.status !== 'live') {
    throw new Error('This live session is no longer accepting check-ins.');
  }
  if (before.liveSession.checkin_status !== 'open') {
    throw new Error('Check-in is closed for this live session.');
  }
  if (
    response !== 'playing'
    && (
      before.liveSession.winner_discord_user_id === discordUserId
      || before.liveSession.mvp_discord_user_id === discordUserId
    )
  ) {
    throw new Error('Ask an operator to update winner or MVP before leaving the player roster.');
  }

  const timestamp = new Date().toISOString();
  const { data, error } = await supabase
    .from('live_session_confirmations')
    .upsert({
      guild_id: guildId,
      live_session_id: liveSessionId,
      discord_user_id: discordUserId,
      response,
      source,
      updated_at: timestamp,
    }, { onConflict: 'live_session_id,discord_user_id' })
    .select()
    .single();

  if (error) throw error;

  const nextRoster = applyConfirmationToRoster(before.people, discordUserId, response);
  const { error: deleteError } = await supabase
    .from('live_session_people')
    .delete()
    .eq('live_session_id', liveSessionId)
    .eq('guild_id', guildId)
    .eq('discord_user_id', discordUserId);

  if (deleteError) throw deleteError;

  if (response !== 'not_in_session') {
    const role = response === 'playing' ? 'player' : 'spectator';
    const { error: upsertError } = await supabase
      .from('live_session_people')
      .upsert({
        live_session_id: liveSessionId,
        guild_id: guildId,
        discord_user_id: discordUserId,
        roster_role: role,
        source: 'manual',
        updated_at: timestamp,
      }, { onConflict: 'live_session_id,discord_user_id' });

    if (upsertError) throw upsertError;
  }

  const afterPeople = await listLiveSessionPeople(liveSessionId, guildId);
  await writeAuditLog({
    guildId,
    actorDiscordId: discordUserId,
    actionType: 'live_session_checkin_response',
    targetType: 'live_session',
    targetId: liveSessionId,
    requestId,
    before: {
      live_session_id: liveSessionId,
      roster_role: before.people.find(row => row.discord_user_id === discordUserId)?.roster_role || null,
    },
    after: {
      live_session_id: liveSessionId,
      response,
      roster_role: afterPeople.find(row => row.discord_user_id === discordUserId)?.roster_role || null,
    },
    metadata: {
      guild_id: guildId,
      live_session_id: liveSessionId,
      response,
      source,
    },
  });

  return {
    confirmation: normalizeConfirmation(data),
    liveSession: before.liveSession,
    people: afterPeople,
    nextRoster,
  };
}

module.exports = {
  CHECKIN_RESPONSES,
  applyConfirmationToRoster,
  listLiveSessionConfirmations,
  normalizeConfirmation,
  recordLiveSessionConfirmation,
  setLiveSessionCheckinStatus,
};
