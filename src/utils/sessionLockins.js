const supabase = require('./supabase');
const { writeAuditLog } = require('./audit');
const { resolveDraftParticipantSelection } = require('./sessionLockinRoster');

function normalizeNotes(input) {
  if (input == null) return null;
  const normalized = String(input).trim();
  return normalized || null;
}

function normalizeLockinDraft(row = {}) {
  if (!row) return null;

  return {
    id: row.id,
    guild_id: row.guild_id,
    session_candidate_id: row.session_candidate_id,
    scheduled_session_id: row.scheduled_session_id,
    selection_source: row.selection_source,
    notes: row.notes,
    locked_by_discord_user_id: row.locked_by_discord_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeLockinDraftPlayer(row = {}) {
  return {
    id: row.id,
    session_lockin_draft_id: row.session_lockin_draft_id,
    guild_id: row.guild_id,
    discord_user_id: row.discord_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getCandidateForLockin(guildId, candidateId) {
  if (!guildId || !candidateId) return null;

  const { data, error } = await supabase
    .from('session_candidates')
    .select('*')
    .eq('guild_id', guildId)
    .eq('id', candidateId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function listCandidateParticipantsForLockin(candidateId, guildId) {
  const { data, error } = await supabase
    .from('candidate_participants')
    .select('*')
    .eq('session_candidate_id', candidateId)
    .eq('guild_id', guildId)
    .order('total_presence_seconds', { ascending: false })
    .order('discord_user_id', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function getLockinDraftByCandidateId(guildId, candidateId) {
  if (!guildId || !candidateId) return null;

  const { data, error } = await supabase
    .from('session_lockin_drafts')
    .select('*')
    .eq('guild_id', guildId)
    .eq('session_candidate_id', candidateId)
    .maybeSingle();

  if (error) throw error;
  return normalizeLockinDraft(data);
}

async function listLockinDraftPlayers(lockinDraftId, guildId) {
  if (!lockinDraftId) return [];

  let query = supabase
    .from('session_lockin_draft_players')
    .select('*')
    .eq('session_lockin_draft_id', lockinDraftId)
    .order('discord_user_id', { ascending: true });

  if (guildId) {
    query = query.eq('guild_id', guildId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(normalizeLockinDraftPlayer);
}

async function getLockinDraftWithPlayers(guildId, candidateId) {
  const draft = await getLockinDraftByCandidateId(guildId, candidateId);
  if (!draft) {
    return { draft: null, players: [] };
  }

  const players = await listLockinDraftPlayers(draft.id, guildId);
  return { draft, players };
}

async function upsertSessionLockinDraft({
  guildId,
  candidateId,
  actorDiscordId,
  participantIds = null,
  notes = null,
  requestId = null,
}) {
  if (!guildId) throw new Error('guildId is required.');
  if (!candidateId) throw new Error('candidateId is required.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required.');

  const candidate = await getCandidateForLockin(guildId, candidateId);
  if (!candidate) {
    throw new Error('Session candidate not found in this server.');
  }

  if (candidate.status === 'finalized') {
    throw new Error('A finalized session candidate cannot be locked in again.');
  }

  if (candidate.status === 'discarded') {
    throw new Error('A discarded session candidate cannot be locked in.');
  }

  if (candidate.status !== 'closed') {
    throw new Error('Only closed session candidates can be locked in.');
  }

  if (candidate.participant_snapshot_status !== 'ready') {
    throw new Error('Candidate participant snapshot is not ready yet. Wait for the candidate to finish building its participant pool before locking it in.');
  }

  const candidateParticipants = await listCandidateParticipantsForLockin(candidateId, guildId);
  if (!candidateParticipants.length) {
    throw new Error('Candidate participant rows are missing. Resolve candidate integrity before creating a lock-in draft.');
  }

  const selection = resolveDraftParticipantSelection(candidateParticipants, participantIds);
  const before = await getLockinDraftWithPlayers(guildId, candidateId);
  const draftPayload = {
    guild_id: guildId,
    session_candidate_id: candidateId,
    scheduled_session_id: candidate.scheduled_session_id || null,
    selection_source: selection.selectionSource,
    notes: normalizeNotes(notes),
    locked_by_discord_user_id: actorDiscordId,
    updated_at: new Date().toISOString(),
  };

  let draft;
  if (before.draft) {
    const { data, error } = await supabase
      .from('session_lockin_drafts')
      .update(draftPayload)
      .eq('id', before.draft.id)
      .eq('guild_id', guildId)
      .select()
      .single();

    if (error) throw error;
    draft = normalizeLockinDraft(data);
  } else {
    const { data, error } = await supabase
      .from('session_lockin_drafts')
      .insert({
        ...draftPayload,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    draft = normalizeLockinDraft(data);
  }

  const { error: deleteError } = await supabase
    .from('session_lockin_draft_players')
    .delete()
    .eq('session_lockin_draft_id', draft.id);

  if (deleteError) throw deleteError;

  const playerRows = selection.participantIds.map(discordUserId => ({
    session_lockin_draft_id: draft.id,
    guild_id: guildId,
    discord_user_id: discordUserId,
  }));

  if (playerRows.length) {
    const { error: insertError } = await supabase
      .from('session_lockin_draft_players')
      .insert(playerRows);

    if (insertError) throw insertError;
  }

  const after = await getLockinDraftWithPlayers(guildId, candidateId);
  await writeAuditLog({
    guildId,
    actorDiscordId,
    actionType: 'session_candidate_lockin_upserted',
    targetType: 'session_lockin_draft',
    targetId: after.draft.id,
    requestId,
    before: before.draft
      ? {
        ...before.draft,
        participant_ids: before.players.map(row => row.discord_user_id),
      }
      : null,
    after: {
      ...after.draft,
      participant_ids: after.players.map(row => row.discord_user_id),
    },
    metadata: {
      guild_id: guildId,
      candidate_id: candidateId,
      scheduled_session_id: after.draft.scheduled_session_id,
      selection_source: after.draft.selection_source,
      participant_ids: after.players.map(row => row.discord_user_id),
    },
  });

  return after;
}

module.exports = {
  getLockinDraftByCandidateId,
  getLockinDraftWithPlayers,
  listLockinDraftPlayers,
  normalizeLockinDraft,
  upsertSessionLockinDraft,
};
