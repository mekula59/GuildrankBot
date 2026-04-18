const supabase = require('./supabase');
const logger = require('./logger');
const { writeAuditLog } = require('./audit');
const { enqueueStatsRepair } = require('./repairs');
const { recalculateAllStats } = require('../jobs/recalcStats');
const { getTrackedVoiceChannel, isTrackedVoiceChannelEnabled, listTrackedVoiceChannels } = require('./trackedVoiceChannels');
const { findMatchingScheduledSession } = require('./scheduledSessions');
const { getLockinDraftWithPlayers } = require('./sessionLockins');
const { resolveFinalizeParticipantSelection } = require('./sessionLockinRoster');
const {
  buildCandidateParticipantRows,
  resolveThresholdReachedAt,
} = require('./sessionCandidateMath');

const candidateOpenTimers = new Map();
const candidateCloseTimers = new Map();

function buildChannelKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function clearManagedTimer(store, key) {
  const existing = store.get(key);
  if (existing) {
    clearTimeout(existing.timeoutId);
    store.delete(key);
  }
}

function setManagedTimer(store, key, delayMs, callback, metadata = {}) {
  clearManagedTimer(store, key);

  const timeoutId = setTimeout(async () => {
    store.delete(key);
    try {
      await callback();
    } catch (error) {
      logger.error('session_candidate_timer_failed', {
        channel_key: key,
        delay_ms: delayMs,
        metadata,
        error,
      });
    }
  }, Math.max(0, delayMs));

  store.set(key, { timeoutId, metadata });
}

function getActiveHumanMembers(guild, channelId) {
  if (!guild || !channelId) return [];
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased?.()) return [];
  return [...channel.members.values()].filter(member => !member.user?.bot);
}

async function getOpenSessionCandidate(guildId, channelId) {
  const { data, error } = await supabase
    .from('session_candidates')
    .select('*')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .eq('status', 'open')
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getSessionCandidateById(guildId, candidateId) {
  const { data, error } = await supabase
    .from('session_candidates')
    .select('*')
    .eq('guild_id', guildId)
    .eq('id', candidateId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function updateCandidateParticipantSnapshot(candidateId, fields = {}) {
  const { data, error } = await supabase
    .from('session_candidates')
    .update({
      ...fields,
      updated_at: new Date().toISOString(),
    })
    .eq('id', candidateId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function listSessionCandidates(guildId, {
  statuses = ['open', 'closed'],
  channelId = null,
  limit = 10,
} = {}) {
  if (!guildId) throw new Error('guildId is required.');

  let query = supabase
    .from('session_candidates')
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
  return data || [];
}

async function listOpenSessionCandidatesForGuild(guildId) {
  return listSessionCandidates(guildId, { statuses: ['open'], limit: 100 });
}

async function listCandidateParticipants(candidateId, guildId) {
  let query = supabase
    .from('candidate_participants')
    .select('*')
    .eq('session_candidate_id', candidateId)
    .order('total_presence_seconds', { ascending: false })
    .order('discord_user_id', { ascending: true });

  if (guildId) {
    query = query.eq('guild_id', guildId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

function assertCandidateStatus(candidate, allowedStatuses, actionLabel) {
  if (!candidate) {
    throw new Error('Session candidate not found in this server.');
  }

  if (!allowedStatuses.includes(candidate.status)) {
    throw new Error(`Session candidate must be ${allowedStatuses.join(' or ')} to ${actionLabel}. Current status: ${candidate.status}.`);
  }
}

function clearCandidateTimers(candidate) {
  if (!candidate?.guild_id || !candidate?.channel_id) return;
  const key = buildChannelKey(candidate.guild_id, candidate.channel_id);
  clearManagedTimer(candidateOpenTimers, key);
  clearManagedTimer(candidateCloseTimers, key);
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

async function listOpenPresenceSegments(guildId, channelId) {
  const { data, error } = await supabase
    .from('voice_presence_segments')
    .select('*')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .eq('segment_status', 'open')
    .order('joined_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function listPresenceSegmentsForWindow(guildId, channelId, endedAt) {
  const { data, error } = await supabase
    .from('voice_presence_segments')
    .select('*')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .lte('joined_at', endedAt.toISOString())
    .order('joined_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function createSessionCandidate({ guildId, channelId, trackedVoiceChannel, startedAt, detectedMemberCount }) {
  const scheduleMatch = await findMatchingScheduledSession({
    guildId,
    channelId,
    startedAt,
  });

  const payload = {
    guild_id: guildId,
    tracked_voice_channel_id: trackedVoiceChannel.id,
    channel_id: channelId,
    channel_name_snapshot: trackedVoiceChannel.channel_name_snapshot,
    game_key: trackedVoiceChannel.game_key,
    session_type: trackedVoiceChannel.session_type,
    min_active_members_snapshot: trackedVoiceChannel.min_active_members,
    min_candidate_duration_minutes_snapshot: trackedVoiceChannel.min_candidate_duration_minutes,
    min_participant_presence_minutes_snapshot: trackedVoiceChannel.min_participant_presence_minutes,
    grace_gap_seconds_snapshot: trackedVoiceChannel.grace_gap_seconds,
    scheduled_session_id: scheduleMatch.scheduledSession?.id || null,
    schedule_match_status: scheduleMatch.scheduleMatchStatus,
    schedule_match_checked_at: new Date().toISOString(),
    status: 'open',
    started_at: startedAt.toISOString(),
    last_activity_at: new Date().toISOString(),
    detected_member_count: detectedMemberCount,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('session_candidates')
    .insert(payload)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return getOpenSessionCandidate(guildId, channelId);
    }
    throw error;
  }

  await writeAuditLog({
    guildId,
    actorDiscordId: null,
    actionType: 'session_candidate_created',
    targetType: 'session_candidate',
    targetId: data.id,
    before: null,
    after: data,
    metadata: {
      guild_id: guildId,
      channel_id: channelId,
      tracked_voice_channel_id: trackedVoiceChannel.id,
      game_key: trackedVoiceChannel.game_key,
      session_type: trackedVoiceChannel.session_type,
      min_active_members: trackedVoiceChannel.min_active_members,
      min_candidate_duration_minutes: trackedVoiceChannel.min_candidate_duration_minutes,
      scheduled_session_id: data.scheduled_session_id,
      schedule_match_status: data.schedule_match_status,
    },
  });

  logger.info('session_candidate_created', {
    guild_id: guildId,
    channel_id: channelId,
    session_candidate_id: data.id,
    tracked_voice_channel_id: trackedVoiceChannel.id,
  });

  return data;
}

async function touchOpenCandidate(candidate, detectedMemberCount) {
  const { data, error } = await supabase
    .from('session_candidates')
    .update({
      last_activity_at: new Date().toISOString(),
      detected_member_count: Math.max(candidate.detected_member_count || 0, detectedMemberCount || 0),
      updated_at: new Date().toISOString(),
    })
    .eq('id', candidate.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function refreshCandidateParticipants(candidate, trackedVoiceChannel) {
  const segments = await listPresenceSegmentsForWindow(candidate.guild_id, candidate.channel_id, new Date(candidate.ended_at));
  const rows = buildCandidateParticipantRows({
    sessionCandidateId: candidate.id,
    guildId: candidate.guild_id,
    segments,
    startedAt: candidate.started_at,
    endedAt: candidate.ended_at,
    minParticipantPresenceMinutes: candidate.min_participant_presence_minutes_snapshot ?? trackedVoiceChannel.min_participant_presence_minutes,
    graceGapSeconds: candidate.grace_gap_seconds_snapshot ?? trackedVoiceChannel.grace_gap_seconds,
  });

  const { error: deleteError } = await supabase
    .from('candidate_participants')
    .delete()
    .eq('session_candidate_id', candidate.id);

  if (deleteError) throw deleteError;

  if (rows.length) {
    const { error: insertError } = await supabase
      .from('candidate_participants')
      .insert(rows);

    if (insertError) throw insertError;
  }

  await updateCandidateParticipantSnapshot(candidate.id, {
    participant_snapshot_status: 'ready',
    participant_snapshot_refreshed_at: new Date().toISOString(),
    participant_snapshot_error: null,
  });

  return rows;
}

async function closeSessionCandidate(candidate, trackedVoiceChannel, endedAt) {
  const closedAt = endedAt instanceof Date ? endedAt : new Date(endedAt);
  const before = { ...candidate };
  const scheduleMatch = await findMatchingScheduledSession({
    guildId: candidate.guild_id,
    channelId: candidate.channel_id,
    startedAt: candidate.started_at,
  });

  const { data, error } = await supabase
    .from('session_candidates')
    .update({
      status: 'closed',
      ended_at: closedAt.toISOString(),
      scheduled_session_id: scheduleMatch.scheduledSession?.id || null,
      schedule_match_status: scheduleMatch.scheduleMatchStatus,
      schedule_match_checked_at: new Date().toISOString(),
      participant_snapshot_status: 'pending',
      participant_snapshot_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', candidate.id)
    .eq('status', 'open')
    .select()
    .single();

  if (error) throw error;

  let participants = [];
  try {
    participants = await refreshCandidateParticipants(data, trackedVoiceChannel);
  } catch (error) {
    await updateCandidateParticipantSnapshot(data.id, {
      participant_snapshot_status: 'failed',
      participant_snapshot_error: error.message || 'participant_refresh_failed',
    });

    logger.error('session_candidate_participant_refresh_failed', {
      guild_id: data.guild_id,
      channel_id: data.channel_id,
      session_candidate_id: data.id,
      error,
    });
  }

  const afterCandidate = await getSessionCandidateById(data.guild_id, data.id);

  await writeAuditLog({
    guildId: afterCandidate.guild_id,
    actorDiscordId: null,
    actionType: 'session_candidate_closed',
    targetType: 'session_candidate',
    targetId: afterCandidate.id,
    before,
    after: afterCandidate,
    metadata: {
      guild_id: afterCandidate.guild_id,
      channel_id: afterCandidate.channel_id,
      tracked_voice_channel_id: afterCandidate.tracked_voice_channel_id,
      game_key: afterCandidate.game_key,
      session_type: afterCandidate.session_type,
      scheduled_session_id: afterCandidate.scheduled_session_id,
      schedule_match_status: afterCandidate.schedule_match_status,
      candidate_participant_count: participants.length,
      participant_snapshot_status: afterCandidate.participant_snapshot_status,
      participant_snapshot_error: afterCandidate.participant_snapshot_error,
    },
  });

  logger.info('session_candidate_closed', {
    guild_id: data.guild_id,
    channel_id: data.channel_id,
    session_candidate_id: data.id,
    participant_count: participants.length,
  });

  return afterCandidate;
}

async function ensureCandidateParticipantSnapshotReady(candidate) {
  if (!candidate) {
    throw new Error('Session candidate not found in this server.');
  }

  if (candidate.status !== 'closed') {
    return candidate;
  }

  const existingParticipants = await listCandidateParticipants(candidate.id, candidate.guild_id);
  if (candidate.participant_snapshot_status === 'ready' && existingParticipants.length > 0) {
    return candidate;
  }

  const trackedVoiceChannel = await getTrackedVoiceChannel(candidate.guild_id, candidate.channel_id, { useCache: false });
  if (!trackedVoiceChannel && (
    candidate.min_participant_presence_minutes_snapshot == null
    || candidate.grace_gap_seconds_snapshot == null
  )) {
    throw new Error('This candidate no longer has a valid tracked voice channel configuration for participant recompute.');
  }

  try {
    await updateCandidateParticipantSnapshot(candidate.id, {
      participant_snapshot_status: 'pending',
      participant_snapshot_error: null,
    });

    await refreshCandidateParticipants(candidate, trackedVoiceChannel);
    return getSessionCandidateById(candidate.guild_id, candidate.id);
  } catch (error) {
    await updateCandidateParticipantSnapshot(candidate.id, {
      participant_snapshot_status: 'failed',
      participant_snapshot_error: error.message || 'participant_recompute_failed',
    });
    throw new Error('Candidate participant rows are missing or stale and recompute failed. Resolve candidate integrity before finalizing.');
  }
}

async function finalizeSessionCandidate({
  requestId,
  guildId,
  candidateId,
  actorDiscordId,
  scheduledSessionId = null,
  participantIds = null,
  notes = null,
  winnerId = null,
  mvpId = null,
}) {
  if (!requestId) throw new Error('requestId is required for idempotent candidate finalization.');
  if (!guildId) throw new Error('guildId is required.');
  if (!candidateId) throw new Error('candidateId is required.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required.');

  const beforeCandidate = await getSessionCandidateById(guildId, candidateId);
  assertCandidateStatus(beforeCandidate, ['closed'], 'finalize');
  clearCandidateTimers(beforeCandidate);

  const candidateForFinalize = await ensureCandidateParticipantSnapshotReady(beforeCandidate);
  if (candidateForFinalize.participant_snapshot_status !== 'ready') {
    throw new Error('Candidate participant snapshot is not ready for finalize.');
  }

  const candidateParticipants = await listCandidateParticipants(candidateId, guildId);
  if (!candidateParticipants.length) {
    throw new Error('Candidate participant rows are missing. Recompute is required before finalizing.');
  }
  const lockinDraft = participantIds?.length
    ? { draft: null, players: [] }
    : await getLockinDraftWithPlayers(guildId, candidateId);
  const participantSelection = resolveFinalizeParticipantSelection(candidateParticipants, {
    explicitParticipantIds: participantIds,
    lockedParticipantIds: lockinDraft.players.map(row => row.discord_user_id),
  });
  const selectedParticipantIds = participantSelection.participantIds;

  const { data: rpcRows, error: rpcError } = await supabase.rpc('finalize_session_candidate', {
    p_request_id: requestId,
    p_guild_id: guildId,
    p_candidate_id: candidateId,
    p_actor_discord_id: actorDiscordId,
    p_participant_ids: selectedParticipantIds,
    p_notes: notes || null,
    p_winner_id: winnerId || null,
    p_mvp_id: mvpId || null,
    p_scheduled_session_id: scheduledSessionId || null,
  });

  if (rpcError) {
    const message = rpcError.message || '';
    if (message.includes('candidate_not_found')) throw new Error('Session candidate not found in this server.');
    if (message.includes('candidate_already_finalized')) throw new Error('This session candidate has already been finalized.');
    if (message.includes('candidate_discarded')) throw new Error('This session candidate has already been discarded.');
    if (message.includes('candidate_not_closed')) throw new Error('Only closed session candidates can be finalized.');
    if (message.includes('participant_ids_required')) throw new Error('At least one participant is required to finalize a session candidate.');
    if (message.includes('invalid_participant_ids')) throw new Error('One or more selected participants are not part of the candidate pool.');
    if (message.includes('winner_not_in_participants')) throw new Error('Winner must be included in the finalized participant list.');
    if (message.includes('mvp_not_in_participants')) throw new Error('MVP must be included in the finalized participant list.');
    if (message.includes('scheduled_session_not_found')) throw new Error('Scheduled session not found in this server.');
    if (message.includes('scheduled_session_cancelled')) throw new Error('A cancelled scheduled session cannot be linked during finalize.');
    if (message.includes('scheduled_session_already_completed')) throw new Error('That scheduled session is already linked to another completed official session.');
    throw rpcError;
  }

  const rpcRow = rpcRows?.[0];
  if (!rpcRow?.event_id) {
    throw new Error('Candidate finalization failed: database did not return an official session.');
  }

  let statsRebuilt = false;
  try {
    await recalculateAllStats({ guildId, reason: 'vc_candidate_finalize', requestId });
    statsRebuilt = true;
  } catch (error) {
    await enqueueStatsRepair({
      guildId,
      requestId,
      requestedBy: actorDiscordId,
      reason: error.message || 'vc_candidate_finalize_recalc_failed',
      metadata: {
        candidate_id: candidateId,
        event_id: rpcRow.event_id,
        source: 'vc_candidate_finalize',
      },
    }).catch(enqueueError => {
      logger.error('vc_candidate_finalize_repair_enqueue_failed', {
        guild_id: guildId,
        request_id: requestId,
        candidate_id: candidateId,
        event_id: rpcRow.event_id,
        error: enqueueError,
      });
    });

    logger.error('vc_candidate_finalize_recalc_failed', {
      guild_id: guildId,
      request_id: requestId,
      candidate_id: candidateId,
      event_id: rpcRow.event_id,
      error,
    });
  }

  const afterCandidate = await getSessionCandidateById(guildId, candidateId);
  const officialEvent = await getOfficialEventSnapshot(guildId, rpcRow.event_id);

  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: 'session_candidate_finalized',
    targetType: 'session_candidate',
    targetId: candidateId,
    requestId,
    before: beforeCandidate,
    after: afterCandidate,
    metadata: {
      guild_id: guildId,
      candidate_id: candidateId,
      official_event_id: rpcRow.event_id,
      source_type: officialEvent?.source_type,
      source_candidate_id: officialEvent?.source_candidate_id,
      scheduled_session_id: officialEvent?.scheduled_session_id || null,
      participant_ids: officialEvent?.participant_ids || selectedParticipantIds,
      participant_selection_source: participantSelection.selectionSource,
      lockin_draft_id: lockinDraft.draft?.id || null,
      winner_id: officialEvent?.winner_id || null,
      mvp_id: officialEvent?.mvp_id || null,
      stats_rebuilt: statsRebuilt,
    },
  });

  logger.info('session_candidate_finalized', {
    guild_id: guildId,
    candidate_id: candidateId,
    official_event_id: rpcRow.event_id,
    participant_count: officialEvent?.participant_ids?.length || selectedParticipantIds.length,
    stats_rebuilt: statsRebuilt,
  });

  return {
    candidate: afterCandidate,
    officialEvent,
    duplicate: rpcRow.created === false,
    participantSource: participantSelection.selectionSource,
    statsRebuilt,
  };
}

async function discardSessionCandidate({
  guildId,
  candidateId,
  actorDiscordId,
  reason,
  requestId = null,
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!candidateId) throw new Error('candidateId is required.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required.');
  if (!reason || !String(reason).trim()) throw new Error('reason is required to discard a session candidate.');

  const beforeCandidate = await getSessionCandidateById(guildId, candidateId);
  if (!beforeCandidate) {
    throw new Error('Session candidate not found in this server.');
  }
  if (beforeCandidate.status === 'finalized') {
    throw new Error('A finalized session candidate cannot be discarded.');
  }
  if (!['open', 'closed', 'discarded'].includes(beforeCandidate.status)) {
    throw new Error(`Session candidate cannot be discarded from status ${beforeCandidate.status}.`);
  }

  clearCandidateTimers(beforeCandidate);

  const { data: rpcRows, error: rpcError } = await supabase.rpc('discard_session_candidate', {
    p_guild_id: guildId,
    p_candidate_id: candidateId,
    p_actor_discord_id: actorDiscordId,
    p_reason: reason,
  });

  if (rpcError) {
    const message = rpcError.message || '';
    if (message.includes('candidate_not_found')) throw new Error('Session candidate not found in this server.');
    if (message.includes('candidate_already_finalized')) throw new Error('A finalized session candidate cannot be discarded.');
    if (message.includes('discard_reason_required')) throw new Error('A discard reason is required.');
    throw rpcError;
  }

  const rpcRow = rpcRows?.[0];
  const afterCandidate = await getSessionCandidateById(guildId, candidateId);

  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: 'session_candidate_discarded',
    targetType: 'session_candidate',
    targetId: candidateId,
    requestId,
    reason,
    before: beforeCandidate,
    after: afterCandidate,
    metadata: {
      guild_id: guildId,
      candidate_id: candidateId,
      already_discarded: Boolean(rpcRow?.already_discarded),
    },
  });

  logger.info('session_candidate_discarded', {
    guild_id: guildId,
    candidate_id: candidateId,
    already_discarded: Boolean(rpcRow?.already_discarded),
  });

  return {
    candidate: afterCandidate,
    alreadyDiscarded: Boolean(rpcRow?.already_discarded),
  };
}

async function evaluateTrackedChannelCandidate(guild, channelId, { evaluationTime = new Date(), forcedEndedAt = null } = {}) {
  const guildId = guild?.id;
  if (!guildId || !channelId) return { action: 'noop' };

  const trackedVoiceChannel = await getTrackedVoiceChannel(guildId, channelId, { useCache: false });
  const key = buildChannelKey(guildId, channelId);
  const openCandidate = await getOpenSessionCandidate(guildId, channelId);
  const activeThreshold = openCandidate?.min_active_members_snapshot ?? trackedVoiceChannel?.min_active_members;
  const closeGraceGapSeconds = openCandidate?.grace_gap_seconds_snapshot ?? trackedVoiceChannel?.grace_gap_seconds;

  if (!isTrackedVoiceChannelEnabled(trackedVoiceChannel)) {
    clearManagedTimer(candidateOpenTimers, key);
    clearManagedTimer(candidateCloseTimers, key);
    if (!openCandidate) return { action: 'noop' };
    await closeSessionCandidate(openCandidate, {
      ...(trackedVoiceChannel || {}),
      min_participant_presence_minutes: trackedVoiceChannel?.min_participant_presence_minutes ?? 5,
      grace_gap_seconds: trackedVoiceChannel?.grace_gap_seconds ?? 180,
    }, forcedEndedAt || evaluationTime);
    return { action: 'closed' };
  }

  const activeMembers = getActiveHumanMembers(guild, channelId);
  const activeMemberCount = activeMembers.length;

  if (activeMemberCount >= activeThreshold) {
    clearManagedTimer(candidateCloseTimers, key);

    const openSegments = await listOpenPresenceSegments(guildId, channelId);
    const thresholdReachedAt = resolveThresholdReachedAt(openSegments, trackedVoiceChannel.min_active_members);

    if (openCandidate) {
      await touchOpenCandidate(openCandidate, activeMemberCount);
      return { action: 'touched', candidateId: openCandidate.id };
    }

    if (!thresholdReachedAt) {
      clearManagedTimer(candidateOpenTimers, key);
      return { action: 'noop' };
    }

    const thresholdDelayMs = trackedVoiceChannel.min_candidate_duration_minutes * 60 * 1000;
    const readyAtMs = thresholdReachedAt.getTime() + thresholdDelayMs;
    const remainingMs = readyAtMs - evaluationTime.getTime();

    if (remainingMs <= 0) {
      const created = await createSessionCandidate({
        guildId,
        channelId,
        trackedVoiceChannel,
        startedAt: thresholdReachedAt,
        detectedMemberCount: activeMemberCount,
      });
      clearManagedTimer(candidateOpenTimers, key);
      return { action: 'opened', candidateId: created.id };
    }

    setManagedTimer(
      candidateOpenTimers,
      key,
      remainingMs,
      () => evaluateTrackedChannelCandidate(guild, channelId, { evaluationTime: new Date() }),
      { purpose: 'candidate_open', guild_id: guildId, channel_id: channelId }
    );

    return { action: 'waiting_for_threshold' };
  }

  clearManagedTimer(candidateOpenTimers, key);

  if (!openCandidate) {
    clearManagedTimer(candidateCloseTimers, key);
    return { action: 'noop' };
  }

  const graceDelayMs = Math.max(0, closeGraceGapSeconds) * 1000;
  const effectiveEndedAt = forcedEndedAt || evaluationTime;
  if (forcedEndedAt && evaluationTime.getTime() - effectiveEndedAt.getTime() >= graceDelayMs) {
    clearManagedTimer(candidateCloseTimers, key);
    await closeSessionCandidate(openCandidate, trackedVoiceChannel, effectiveEndedAt);
    return { action: 'closed', candidateId: openCandidate.id };
  }

  if (graceDelayMs === 0) {
    clearManagedTimer(candidateCloseTimers, key);
    await closeSessionCandidate(openCandidate, trackedVoiceChannel, effectiveEndedAt);
    return { action: 'closed', candidateId: openCandidate.id };
  }

  setManagedTimer(
    candidateCloseTimers,
    key,
    graceDelayMs,
    () => evaluateTrackedChannelCandidate(guild, channelId, {
      evaluationTime: new Date(),
      forcedEndedAt: effectiveEndedAt,
    }),
    { purpose: 'candidate_close', guild_id: guildId, channel_id: channelId }
  );

  return { action: 'waiting_for_close_grace', candidateId: openCandidate.id };
}

async function syncSessionCandidatesFromStateChange(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  const channelIds = [...new Set([oldState.channelId, newState.channelId].filter(Boolean))];
  const results = [];

  for (const channelId of channelIds) {
    const result = await evaluateTrackedChannelCandidate(guild, channelId);
    results.push({ channelId, ...result });
  }

  return results;
}

async function reconcileTrackedChannelState(guild, channelId) {
  return evaluateTrackedChannelCandidate(guild, channelId, { evaluationTime: new Date() });
}

async function recoverTrackedChannelCandidateTiming(guild, channelId) {
  const guildId = guild?.id;
  if (!guildId || !channelId) return { action: 'noop', recovery: true };

  const trackedVoiceChannel = await getTrackedVoiceChannel(guildId, channelId, { useCache: false });
  const openCandidate = await getOpenSessionCandidate(guildId, channelId);
  const activeMembers = getActiveHumanMembers(guild, channelId);
  const activeMemberCount = activeMembers.length;

  const minActiveMembers = openCandidate?.min_active_members_snapshot
    ?? trackedVoiceChannel?.min_active_members
    ?? 2;

  if (openCandidate && activeMemberCount < minActiveMembers) {
    const recoveryEndedAt = openCandidate.last_activity_at
      ? new Date(openCandidate.last_activity_at)
      : new Date();
    const result = await evaluateTrackedChannelCandidate(guild, channelId, {
      evaluationTime: new Date(),
      forcedEndedAt: recoveryEndedAt,
    });

    logger.info('session_candidate_timing_recovered', {
      guild_id: guildId,
      channel_id: channelId,
      candidate_id: openCandidate.id,
      recovery_type: 'grace_close',
      active_member_count: activeMemberCount,
      last_activity_at: openCandidate.last_activity_at,
      result,
    });
    return { ...result, recovery: true };
  }

  const result = await evaluateTrackedChannelCandidate(guild, channelId, {
    evaluationTime: new Date(),
  });

  logger.info('session_candidate_timing_recovered', {
    guild_id: guildId,
    channel_id: channelId,
    candidate_id: openCandidate?.id || null,
    recovery_type: openCandidate ? 'open_candidate_reconcile' : 'threshold_open',
    active_member_count: activeMemberCount,
    result,
  });

  return { ...result, recovery: true };
}

async function recoverSessionCandidateTiming(client) {
  const recovered = [];

  for (const guild of client.guilds.cache.values()) {
    const [trackedChannels, openCandidates] = await Promise.all([
      listTrackedVoiceChannels(guild.id, { includeDisabled: false, useCache: false }),
      listOpenSessionCandidatesForGuild(guild.id),
    ]);

    const channelIds = new Set([
      ...trackedChannels.map(row => row.channel_id),
      ...openCandidates.map(row => row.channel_id),
    ]);

    for (const channelId of channelIds) {
      const result = await recoverTrackedChannelCandidateTiming(guild, channelId);
      recovered.push({
        guild_id: guild.id,
        channel_id: channelId,
        result: result.action,
      });
    }
  }

  logger.info('session_candidate_recovery_completed', {
    recovered_channels: recovered.length,
  });

  return recovered;
}

module.exports = {
  discardSessionCandidate,
  ensureCandidateParticipantSnapshotReady,
  evaluateTrackedChannelCandidate,
  finalizeSessionCandidate,
  getSessionCandidateById,
  listCandidateParticipants,
  listSessionCandidates,
  recoverSessionCandidateTiming,
  reconcileTrackedChannelState,
  refreshCandidateParticipants,
  syncSessionCandidatesFromStateChange,
};
