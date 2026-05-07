const supabase = require('./supabase');
const logger = require('./logger');
const { writeAuditLog } = require('./audit');
const { enqueueStatsRepair } = require('./repairs');
const { recalculateAllStats } = require('../jobs/recalcStats');
const { normalizeGameKey } = require('./scheduledSessionTime');
const { getTrackedVoiceChannel, isTrackedVoiceChannelEnabled } = require('./trackedVoiceChannels');
const { getScheduledSessionById } = require('./scheduledSessions');
const {
  ensureCandidateParticipantSnapshotReady,
  getSessionCandidateById,
  listCandidateParticipants,
} = require('./sessionCandidates');
const { getLockinDraftWithPlayers } = require('./sessionLockins');
const {
  partitionCandidateRoster,
  resolveLiveSessionRosterUpdate,
} = require('./liveSessionRoster');

function normalizeNotes(input) {
  if (input == null) return null;
  const normalized = String(input).trim();
  return normalized || null;
}

function normalizeLiveSession(row = {}) {
  if (!row) return null;

  return {
    id: row.id,
    guild_id: row.guild_id,
    tracked_voice_channel_id: row.tracked_voice_channel_id,
    channel_id: row.channel_id,
    channel_name_snapshot: row.channel_name_snapshot,
    game_key: row.game_key,
    session_type: row.session_type,
    started_at: row.started_at,
    ended_at: row.ended_at,
    status: row.status,
    start_context_type: row.start_context_type,
    source_candidate_id: row.source_candidate_id,
    scheduled_session_id: row.scheduled_session_id,
    notes: row.notes,
    winner_discord_user_id: row.winner_discord_user_id,
    mvp_discord_user_id: row.mvp_discord_user_id,
    finalized_official_event_id: row.finalized_official_event_id,
    checkin_status: row.checkin_status || 'closed',
    checkin_opened_at: row.checkin_opened_at,
    checkin_closed_at: row.checkin_closed_at,
    created_by_discord_user_id: row.created_by_discord_user_id,
    updated_by_discord_user_id: row.updated_by_discord_user_id,
    ended_by_discord_user_id: row.ended_by_discord_user_id,
    finalized_by_discord_user_id: row.finalized_by_discord_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeLiveSessionPerson(row = {}) {
  return {
    id: row.id,
    live_session_id: row.live_session_id,
    guild_id: row.guild_id,
    discord_user_id: row.discord_user_id,
    roster_role: row.roster_role,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function duplicateConstraintMatches(error, constraintName) {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.constraint,
  ].filter(Boolean).join(' ');

  return error?.code === '23505' && text.includes(constraintName);
}

async function listLiveSessions(guildId, {
  statuses = ['live', 'ended'],
  channelId = null,
  limit = 20,
} = {}) {
  if (!guildId) throw new Error('guildId is required.');

  let query = supabase
    .from('live_sessions')
    .select('*')
    .eq('guild_id', guildId)
    .order('started_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 25));

  if (Array.isArray(statuses) && statuses.length) {
    query = query.in('status', statuses);
  }

  if (channelId) {
    query = query.eq('channel_id', channelId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(normalizeLiveSession);
}

async function getLiveSessionById(guildId, liveSessionId) {
  if (!guildId || !liveSessionId) return null;

  const { data, error } = await supabase
    .from('live_sessions')
    .select('*')
    .eq('guild_id', guildId)
    .eq('id', liveSessionId)
    .maybeSingle();

  if (error) throw error;
  return normalizeLiveSession(data);
}

async function listLiveSessionPeople(liveSessionId, guildId) {
  let query = supabase
    .from('live_session_people')
    .select('*')
    .eq('live_session_id', liveSessionId)
    .order('roster_role', { ascending: true })
    .order('discord_user_id', { ascending: true });

  if (guildId) {
    query = query.eq('guild_id', guildId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(normalizeLiveSessionPerson);
}

async function getLiveSessionWithPeople(guildId, liveSessionId) {
  const liveSession = await getLiveSessionById(guildId, liveSessionId);
  if (!liveSession) {
    return { liveSession: null, people: [] };
  }

  const people = await listLiveSessionPeople(liveSession.id, guildId);
  return { liveSession, people };
}

async function getCurrentHumanOccupants(guild, channelId) {
  if (!guild || !channelId) return { occupantIds: [], channelNameSnapshot: `vc-${channelId}` };

  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isVoiceBased?.()) {
    return { occupantIds: [], channelNameSnapshot: channel?.name || `vc-${channelId}` };
  }

  return {
    occupantIds: [...channel.members.values()]
      .filter(member => !member.user?.bot)
      .map(member => member.id),
    channelNameSnapshot: channel.name || `vc-${channelId}`,
  };
}

async function getExistingLiveSessionForChannel(guildId, channelId) {
  if (!guildId || !channelId) return null;

  const { data, error } = await supabase
    .from('live_sessions')
    .select('*')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .eq('status', 'live')
    .maybeSingle();

  if (error) throw error;
  return normalizeLiveSession(data);
}

async function getLiveSessionByCandidateId(guildId, candidateId) {
  if (!guildId || !candidateId) return null;

  const { data, error } = await supabase
    .from('live_sessions')
    .select('*')
    .eq('guild_id', guildId)
    .eq('source_candidate_id', candidateId)
    .maybeSingle();

  if (error) throw error;
  return normalizeLiveSession(data);
}

function buildLiveSessionPeopleRows(liveSessionId, guildId, playerIds, spectatorIds, {
  existingPeople = [],
  playerSource = 'manual',
  spectatorSource = 'manual',
  playerIdsProvided = false,
  spectatorIdsProvided = false,
} = {}) {
  const existingMap = new Map(existingPeople.map(row => [row.discord_user_id, row]));
  const rows = [];

  for (const discordUserId of playerIds) {
    const existing = existingMap.get(discordUserId);
    rows.push({
      live_session_id: liveSessionId,
      guild_id: guildId,
      discord_user_id: discordUserId,
      roster_role: 'player',
      source: playerIdsProvided ? playerSource : (existing?.source || playerSource),
      updated_at: new Date().toISOString(),
    });
  }

  for (const discordUserId of spectatorIds) {
    const existing = existingMap.get(discordUserId);
    rows.push({
      live_session_id: liveSessionId,
      guild_id: guildId,
      discord_user_id: discordUserId,
      roster_role: 'spectator',
      source: spectatorIdsProvided ? spectatorSource : (existing?.source || spectatorSource),
      updated_at: new Date().toISOString(),
    });
  }

  return rows;
}

async function applyLiveSessionPeople(liveSessionId, guildId, rows) {
  const currentPeople = await listLiveSessionPeople(liveSessionId, guildId);
  const nextIds = new Set(rows.map(row => row.discord_user_id));
  const deleteIds = currentPeople
    .map(row => row.discord_user_id)
    .filter(discordUserId => !nextIds.has(discordUserId));

  if (rows.length) {
    const { error: upsertError } = await supabase
      .from('live_session_people')
      .upsert(rows, { onConflict: 'live_session_id,discord_user_id' });

    if (upsertError) throw upsertError;
  }

  if (deleteIds.length) {
    const { error: deleteError } = await supabase
      .from('live_session_people')
      .delete()
      .eq('live_session_id', liveSessionId)
      .eq('guild_id', guildId)
      .in('discord_user_id', deleteIds);

    if (deleteError) throw deleteError;
  }

  if (!rows.length && currentPeople.length) {
    const { error: clearError } = await supabase
      .from('live_session_people')
      .delete()
      .eq('live_session_id', liveSessionId)
      .eq('guild_id', guildId);

    if (clearError) throw clearError;
  }
}

async function startLiveSession({
  guild,
  guildId,
  candidateId = null,
  scheduledSessionId = null,
  channelId = null,
  gameKey = null,
  sessionType = null,
  notes = null,
  actorDiscordId,
  requestId = null,
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required.');

  const hasCandidate = Boolean(candidateId);
  const hasSchedule = Boolean(scheduledSessionId);
  const hasChannel = Boolean(channelId);

  if (![hasCandidate, hasSchedule, hasChannel].some(Boolean)) {
    throw new Error('Choose a closed candidate, a scheduled session, or a tracked voice channel to start a live session.');
  }

  if (hasCandidate && (hasSchedule || hasChannel)) {
    throw new Error('When starting from a candidate, do not also pass a schedule or channel.');
  }

  let startContextType;
  let trackedVoiceChannelId = null;
  let resolvedChannelId;
  let channelNameSnapshot;
  let resolvedGameKey;
  let resolvedSessionType;
  let sourceCandidateId = null;
  let resolvedScheduledSessionId = null;
  let sourceCandidate = null;
  let sourceScheduledSession = null;
  let playerIds = [];
  let spectatorIds = [];
  let peopleRows = [];

  if (hasCandidate) {
    const beforeCandidate = await getSessionCandidateById(guildId, candidateId);
    if (!beforeCandidate) {
      throw new Error('Session candidate not found in this server.');
    }
    if (beforeCandidate.status !== 'closed') {
      throw new Error('Live sessions can start only from closed candidates in this slice.');
    }

    if (await getLiveSessionByCandidateId(guildId, beforeCandidate.id)) {
      throw new Error('This detected session already has a live session draft.');
    }

    const candidate = await ensureCandidateParticipantSnapshotReady(beforeCandidate);
    sourceCandidate = candidate;
    const candidateParticipants = await listCandidateParticipants(candidate.id, guildId);
    const lockinDraft = await getLockinDraftWithPlayers(guildId, candidate.id);
    const partitionedRoster = partitionCandidateRoster(
      candidateParticipants,
      lockinDraft.players.map(row => row.discord_user_id)
    );

    startContextType = 'candidate';
    sourceCandidateId = candidate.id;
    resolvedScheduledSessionId = candidate.scheduled_session_id || null;
    trackedVoiceChannelId = candidate.tracked_voice_channel_id || null;
    resolvedChannelId = candidate.channel_id;
    channelNameSnapshot = candidate.channel_name_snapshot || `vc-${candidate.channel_id}`;
    resolvedGameKey = normalizeGameKey(gameKey || candidate.game_key);
    resolvedSessionType = sessionType || candidate.session_type;
    playerIds = partitionedRoster.playerIds;
    spectatorIds = partitionedRoster.spectatorIds;
    peopleRows = buildLiveSessionPeopleRows(
      'pending',
      guildId,
      playerIds,
      spectatorIds,
      {
        playerSource: lockinDraft.players.length ? 'lockin_draft' : 'candidate_threshold',
        spectatorSource: 'candidate_observed',
        playerIdsProvided: true,
        spectatorIdsProvided: true,
      }
    );
  } else if (hasSchedule) {
    const scheduledSession = await getScheduledSessionById(guildId, scheduledSessionId);
    sourceScheduledSession = scheduledSession;
    if (!scheduledSession) {
      throw new Error('Scheduled session not found in this server.');
    }
    if (scheduledSession.status !== 'scheduled') {
      throw new Error('Live sessions can only start from scheduled sessions that are still scheduled.');
    }

    if (scheduledSession.linked_channel_id && hasChannel && scheduledSession.linked_channel_id !== channelId) {
      throw new Error('The selected channel does not match the scheduled session voice channel.');
    }

    resolvedChannelId = channelId || scheduledSession.linked_channel_id;
    if (!resolvedChannelId) {
      throw new Error('This scheduled session does not have a linked voice channel. Provide a voice channel to start the live session.');
    }

    const trackedVoiceChannel = await getTrackedVoiceChannel(guildId, resolvedChannelId, { useCache: false });
    const occupants = await getCurrentHumanOccupants(guild, resolvedChannelId);

    startContextType = 'scheduled_session';
    trackedVoiceChannelId = trackedVoiceChannel?.id || null;
    resolvedScheduledSessionId = scheduledSession.id;
    channelNameSnapshot = occupants.channelNameSnapshot || trackedVoiceChannel?.channel_name_snapshot || `vc-${resolvedChannelId}`;
    resolvedGameKey = normalizeGameKey(gameKey || scheduledSession.game_key);
    resolvedSessionType = sessionType || scheduledSession.session_type;
    spectatorIds = occupants.occupantIds;
    peopleRows = buildLiveSessionPeopleRows(
      'pending',
      guildId,
      [],
      spectatorIds,
      {
        playerSource: 'manual',
        spectatorSource: 'vc_current_occupant',
        playerIdsProvided: true,
        spectatorIdsProvided: true,
      }
    );
  } else {
    const trackedVoiceChannel = await getTrackedVoiceChannel(guildId, channelId, { useCache: false });
    if (!isTrackedVoiceChannelEnabled(trackedVoiceChannel)) {
      throw new Error('That voice channel is not currently tracked and enabled for live sessions.');
    }

    const occupants = await getCurrentHumanOccupants(guild, channelId);

    startContextType = 'tracked_vc';
    trackedVoiceChannelId = trackedVoiceChannel.id;
    resolvedChannelId = channelId;
    channelNameSnapshot = occupants.channelNameSnapshot || trackedVoiceChannel.channel_name_snapshot || `vc-${channelId}`;
    resolvedGameKey = normalizeGameKey(gameKey || trackedVoiceChannel.game_key);
    resolvedSessionType = sessionType || trackedVoiceChannel.session_type;
    spectatorIds = occupants.occupantIds;
    peopleRows = buildLiveSessionPeopleRows(
      'pending',
      guildId,
      [],
      spectatorIds,
      {
        playerSource: 'manual',
        spectatorSource: 'vc_current_occupant',
        playerIdsProvided: true,
        spectatorIdsProvided: true,
      }
    );
  }

  const existingLiveSession = await getExistingLiveSessionForChannel(guildId, resolvedChannelId);
  if (existingLiveSession) {
    throw new Error('There is already a live session running for that voice channel.');
  }

  const before = null;
  const payload = {
    guild_id: guildId,
    tracked_voice_channel_id: trackedVoiceChannelId,
    channel_id: resolvedChannelId,
    channel_name_snapshot: channelNameSnapshot,
    game_key: resolvedGameKey,
    session_type: resolvedSessionType,
    started_at: new Date().toISOString(),
    status: 'live',
    start_context_type: startContextType,
    source_candidate_id: sourceCandidateId,
    scheduled_session_id: resolvedScheduledSessionId,
    notes: normalizeNotes(notes),
    created_by_discord_user_id: actorDiscordId,
    updated_by_discord_user_id: actorDiscordId,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('live_sessions')
    .insert(payload)
    .select()
    .single();

  if (error) {
    logger.error('live_session_start_insert_failed', {
      request_id: requestId,
      guild_id: guildId,
      actor_id: actorDiscordId,
      channel_id: resolvedChannelId,
      start_context_type: startContextType,
      source_candidate_id: sourceCandidateId,
      scheduled_session_id: resolvedScheduledSessionId,
      error,
    });
    if (error.code === '23505') {
      if (duplicateConstraintMatches(error, 'idx_live_sessions_source_candidate')) {
        throw new Error('This detected session already has a live session draft.');
      }

      if (duplicateConstraintMatches(error, 'idx_live_sessions_single_live_per_channel')) {
        throw new Error('A live session is already running for this channel.');
      }

      throw new Error('A live session already exists for that source or channel.');
    }
    throw error;
  }

  const liveSession = normalizeLiveSession(data);
  try {
    await applyLiveSessionPeople(
      liveSession.id,
      guildId,
      peopleRows.map(row => ({
        ...row,
        live_session_id: liveSession.id,
      }))
    );
  } catch (peopleError) {
    logger.error('live_session_start_people_failed', {
      request_id: requestId,
      guild_id: guildId,
      actor_id: actorDiscordId,
      live_session_id: liveSession.id,
      channel_id: liveSession.channel_id,
      start_context_type: liveSession.start_context_type,
      source_candidate_id: liveSession.source_candidate_id,
      scheduled_session_id: liveSession.scheduled_session_id,
      player_count: playerIds.length,
      spectator_count: spectatorIds.length,
      error: peopleError,
    });
    await supabase
      .from('live_sessions')
      .delete()
      .eq('id', liveSession.id)
      .eq('guild_id', guildId)
      .catch(() => {});
    throw peopleError;
  }

  const after = await getLiveSessionWithPeople(guildId, liveSession.id);
  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: 'live_session_started',
    targetType: 'live_session',
    targetId: liveSession.id,
    requestId,
    before,
    after: {
      ...after.liveSession,
      player_ids: after.people.filter(row => row.roster_role === 'player').map(row => row.discord_user_id),
      spectator_ids: after.people.filter(row => row.roster_role === 'spectator').map(row => row.discord_user_id),
    },
    metadata: {
      guild_id: guildId,
      channel_id: liveSession.channel_id,
      start_context_type: liveSession.start_context_type,
      source_candidate_id: liveSession.source_candidate_id,
      scheduled_session_id: liveSession.scheduled_session_id,
    },
  });

  return {
    ...after,
    sourceCandidate,
    sourceScheduledSession,
  };
}

async function updateLiveSession({
  guildId,
  liveSessionId,
  actorDiscordId,
  gameKey = undefined,
  playerIds = undefined,
  spectatorIds = undefined,
  winnerId = undefined,
  mvpId = undefined,
  notes = undefined,
  requestId = null,
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!liveSessionId) throw new Error('liveSessionId is required.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required.');

  const before = await getLiveSessionWithPeople(guildId, liveSessionId);
  if (!before.liveSession) {
    throw new Error('Live session not found in this server.');
  }
  if (before.liveSession.status === 'finalized') {
    throw new Error('A finalized live session cannot be updated.');
  }

  if (
    gameKey === undefined
    && playerIds === undefined
    && spectatorIds === undefined
    && winnerId === undefined
    && mvpId === undefined
    && notes === undefined
  ) {
    throw new Error('Provide at least one live session field to update.');
  }

  const roster = resolveLiveSessionRosterUpdate(before.people, {
    playerIds,
    spectatorIds,
  });

  const effectiveWinnerId = winnerId !== undefined ? winnerId : before.liveSession.winner_discord_user_id;
  const effectiveMvpId = mvpId !== undefined ? mvpId : before.liveSession.mvp_discord_user_id;
  const effectiveNotes = notes !== undefined ? normalizeNotes(notes) : before.liveSession.notes;
  const effectiveGameKey = gameKey !== undefined ? normalizeGameKey(gameKey) : before.liveSession.game_key;
  const playerSet = new Set(roster.playerIds);

  if (effectiveWinnerId && !playerSet.has(effectiveWinnerId)) {
    throw new Error('Winner must be included in the current player roster.');
  }
  if (effectiveMvpId && !playerSet.has(effectiveMvpId)) {
    throw new Error('MVP must be included in the current player roster.');
  }

  const { data, error } = await supabase
    .from('live_sessions')
    .update({
      game_key: effectiveGameKey,
      notes: effectiveNotes,
      winner_discord_user_id: effectiveWinnerId || null,
      mvp_discord_user_id: effectiveMvpId || null,
      updated_by_discord_user_id: actorDiscordId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', liveSessionId)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) throw error;

  await applyLiveSessionPeople(
    liveSessionId,
    guildId,
    buildLiveSessionPeopleRows(
      liveSessionId,
      guildId,
      roster.playerIds,
      roster.spectatorIds,
      {
        existingPeople: before.people,
        playerSource: 'manual',
        spectatorSource: 'manual',
        playerIdsProvided: playerIds !== undefined,
        spectatorIdsProvided: spectatorIds !== undefined,
      }
    )
  );

  const after = await getLiveSessionWithPeople(guildId, liveSessionId);
  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: 'live_session_updated',
    targetType: 'live_session',
    targetId: liveSessionId,
    requestId,
    before: {
      ...before.liveSession,
      player_ids: before.people.filter(row => row.roster_role === 'player').map(row => row.discord_user_id),
      spectator_ids: before.people.filter(row => row.roster_role === 'spectator').map(row => row.discord_user_id),
    },
    after: {
      ...after.liveSession,
      player_ids: after.people.filter(row => row.roster_role === 'player').map(row => row.discord_user_id),
      spectator_ids: after.people.filter(row => row.roster_role === 'spectator').map(row => row.discord_user_id),
    },
    metadata: {
      guild_id: guildId,
      live_session_id: liveSessionId,
    },
  });

  return after;
}

async function endLiveSession({
  guildId,
  liveSessionId,
  actorDiscordId,
  notes = undefined,
  requestId = null,
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!liveSessionId) throw new Error('liveSessionId is required.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required.');

  const before = await getLiveSessionWithPeople(guildId, liveSessionId);
  if (!before.liveSession) {
    throw new Error('Live session not found in this server.');
  }
  if (before.liveSession.status === 'finalized') {
    throw new Error('A finalized live session cannot be ended again.');
  }
  if (before.liveSession.status === 'ended') {
    return before;
  }

  const { data, error } = await supabase
    .from('live_sessions')
    .update({
      status: 'ended',
      ended_at: new Date().toISOString(),
      ended_by_discord_user_id: actorDiscordId,
      checkin_status: 'closed',
      checkin_closed_at: new Date().toISOString(),
      notes: notes !== undefined ? normalizeNotes(notes) : before.liveSession.notes,
      updated_by_discord_user_id: actorDiscordId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', liveSessionId)
    .eq('guild_id', guildId)
    .eq('status', 'live')
    .select()
    .single();

  if (error) throw error;

  const after = await getLiveSessionWithPeople(guildId, liveSessionId);
  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: 'live_session_ended',
    targetType: 'live_session',
    targetId: liveSessionId,
    requestId,
    before: {
      ...before.liveSession,
      player_ids: before.people.filter(row => row.roster_role === 'player').map(row => row.discord_user_id),
      spectator_ids: before.people.filter(row => row.roster_role === 'spectator').map(row => row.discord_user_id),
    },
    after: {
      ...normalizeLiveSession(data),
      player_ids: after.people.filter(row => row.roster_role === 'player').map(row => row.discord_user_id),
      spectator_ids: after.people.filter(row => row.roster_role === 'spectator').map(row => row.discord_user_id),
    },
    metadata: {
      guild_id: guildId,
      live_session_id: liveSessionId,
    },
  });

  return after;
}

async function getEventAttendance(eventId, guildId) {
  const { data, error } = await supabase
    .from('event_attendance')
    .select('discord_id')
    .eq('event_id', eventId)
    .eq('guild_id', guildId);

  if (error) throw error;
  return (data || []).map(row => row.discord_id);
}

async function getOfficialEventSnapshot(guildId, eventId) {
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('*')
    .eq('guild_id', guildId)
    .eq('id', eventId)
    .maybeSingle();

  if (eventError) throw eventError;
  if (!event) return null;

  const participantIds = await getEventAttendance(eventId, guildId);
  return {
    ...event,
    participant_ids: participantIds,
  };
}

async function finalizeLiveSession({
  requestId,
  guildId,
  liveSessionId,
  actorDiscordId,
  participantIds = null,
  scheduledSessionId = null,
  notes = undefined,
  winnerId = undefined,
  mvpId = undefined,
}) {
  if (!requestId) throw new Error('requestId is required for idempotent live session finalization.');
  if (!guildId) throw new Error('guildId is required.');
  if (!liveSessionId) throw new Error('liveSessionId is required.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required.');

  const before = await getLiveSessionWithPeople(guildId, liveSessionId);
  if (!before.liveSession) {
    throw new Error('Live session not found in this server.');
  }
  if (before.liveSession.status === 'live') {
    throw new Error('Finalize only works after the live session has been ended.');
  }
  if (before.liveSession.status === 'finalized') {
    throw new Error('This live session has already been finalized.');
  }

  const currentPlayerIds = before.people
    .filter(row => row.roster_role === 'player')
    .map(row => row.discord_user_id);
  const selectedParticipantIds = participantIds?.length
    ? [...new Set(participantIds.filter(Boolean))]
    : currentPlayerIds;
  const invalidParticipantIds = selectedParticipantIds.filter(id => !currentPlayerIds.includes(id));

  if (invalidParticipantIds.length) {
    throw new Error(`Finalize can only use the current live-session player roster. Update the live session first for these users: ${invalidParticipantIds.map(id => `<@${id}>`).join(', ')}`);
  }
  if (!selectedParticipantIds.length) {
    throw new Error('Live session finalize requires at least one player.');
  }

  const effectiveNotes = notes !== undefined ? normalizeNotes(notes) : before.liveSession.notes;
  const effectiveWinnerId = winnerId !== undefined ? winnerId : before.liveSession.winner_discord_user_id;
  const effectiveMvpId = mvpId !== undefined ? mvpId : before.liveSession.mvp_discord_user_id;
  const effectiveScheduleId = scheduledSessionId || before.liveSession.scheduled_session_id || null;

  const { data: rpcRows, error: rpcError } = await supabase.rpc('finalize_live_session', {
    p_request_id: requestId,
    p_guild_id: guildId,
    p_live_session_id: liveSessionId,
    p_actor_discord_id: actorDiscordId,
    p_player_ids: selectedParticipantIds,
    p_notes: effectiveNotes,
    p_winner_id: effectiveWinnerId || null,
    p_mvp_id: effectiveMvpId || null,
    p_scheduled_session_id: effectiveScheduleId,
  });

  if (rpcError) {
    const message = rpcError.message || '';
    if (message.includes('live_session_not_found')) throw new Error('Live session not found in this server.');
    if (message.includes('live_session_already_finalized')) throw new Error('This live session has already been finalized.');
    if (message.includes('live_session_not_ended')) throw new Error('Finalize only works after the live session has been ended.');
    if (message.includes('live_session_players_required')) throw new Error('Live session finalize requires at least one player.');
    if (message.includes('invalid_live_session_player_ids')) throw new Error('Finalize can only use the current live-session player roster.');
    if (message.includes('winner_not_in_players')) throw new Error('Winner must be included in the finalized player list.');
    if (message.includes('mvp_not_in_players')) throw new Error('MVP must be included in the finalized player list.');
    if (message.includes('scheduled_session_not_found')) throw new Error('Scheduled session not found in this server.');
    if (message.includes('scheduled_session_cancelled')) throw new Error('A cancelled scheduled session cannot be linked during finalize.');
    if (message.includes('scheduled_session_already_completed')) throw new Error('That scheduled session is already linked to another completed official session.');
    if (message.includes('live_session_candidate_link_failed')) throw new Error('The linked candidate could not be consumed by this finalized live session.');
    throw rpcError;
  }

  const rpcRow = rpcRows?.[0];
  if (!rpcRow?.event_id) {
    throw new Error('Live session finalization failed: database did not return an official session.');
  }

  let statsRebuilt = false;
  try {
    await recalculateAllStats({ guildId, reason: 'live_session_finalize', requestId });
    statsRebuilt = true;
  } catch (error) {
    await enqueueStatsRepair({
      guildId,
      requestId,
      requestedBy: actorDiscordId,
      reason: error.message || 'live_session_finalize_recalc_failed',
      metadata: {
        live_session_id: liveSessionId,
        event_id: rpcRow.event_id,
        source: 'live_session_finalize',
      },
    }).catch(enqueueError => {
      logger.error('live_session_finalize_repair_enqueue_failed', {
        guild_id: guildId,
        request_id: requestId,
        live_session_id: liveSessionId,
        event_id: rpcRow.event_id,
        error: enqueueError,
      });
    });

    logger.error('live_session_finalize_recalc_failed', {
      guild_id: guildId,
      request_id: requestId,
      live_session_id: liveSessionId,
      event_id: rpcRow.event_id,
      error,
    });
  }

  const after = await getLiveSessionWithPeople(guildId, liveSessionId);
  const officialEvent = await getOfficialEventSnapshot(guildId, rpcRow.event_id);
  const participantSource = participantIds?.length ? 'explicit_override' : 'live_session_players';

  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: 'live_session_finalized',
    targetType: 'live_session',
    targetId: liveSessionId,
    requestId,
    before: {
      ...before.liveSession,
      player_ids: before.people.filter(row => row.roster_role === 'player').map(row => row.discord_user_id),
      spectator_ids: before.people.filter(row => row.roster_role === 'spectator').map(row => row.discord_user_id),
    },
    after: {
      ...after.liveSession,
      player_ids: after.people.filter(row => row.roster_role === 'player').map(row => row.discord_user_id),
      spectator_ids: after.people.filter(row => row.roster_role === 'spectator').map(row => row.discord_user_id),
    },
    metadata: {
      guild_id: guildId,
      live_session_id: liveSessionId,
      official_event_id: rpcRow.event_id,
      scheduled_session_id: officialEvent?.scheduled_session_id || null,
      participant_ids: officialEvent?.participant_ids || selectedParticipantIds,
      participant_selection_source: participantSource,
      stats_rebuilt: statsRebuilt,
    },
  });

  return {
    liveSession: after.liveSession,
    people: after.people,
    officialEvent,
    duplicate: rpcRow.created === false,
    participantSource,
    statsRebuilt,
  };
}

module.exports = {
  endLiveSession,
  finalizeLiveSession,
  getLiveSessionById,
  getLiveSessionWithPeople,
  listLiveSessionPeople,
  listLiveSessions,
  normalizeLiveSession,
  normalizeLiveSessionPerson,
  startLiveSession,
  updateLiveSession,
};
