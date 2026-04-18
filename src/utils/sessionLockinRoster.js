function dedupeParticipantIds(participantIds = []) {
  return [...new Set((participantIds || []).filter(Boolean))];
}

function validateCandidateParticipantIds(candidateParticipants, participantIds) {
  const requestedIds = dedupeParticipantIds(participantIds);
  const allowedIds = new Set((candidateParticipants || []).map(row => row.discord_user_id));
  const invalidIds = requestedIds.filter(id => !allowedIds.has(id));

  if (invalidIds.length) {
    throw new Error(`These users are not part of the candidate pool: ${invalidIds.map(id => `<@${id}>`).join(', ')}`);
  }

  return requestedIds;
}

function getThresholdParticipantIds(candidateParticipants) {
  return dedupeParticipantIds(
    (candidateParticipants || [])
      .filter(row => row.met_presence_threshold)
      .map(row => row.discord_user_id)
  );
}

function resolveDraftParticipantSelection(candidateParticipants, participantIds = null) {
  const requestedIds = dedupeParticipantIds(participantIds);
  if (requestedIds.length) {
    return {
      participantIds: validateCandidateParticipantIds(candidateParticipants, requestedIds),
      selectionSource: 'admin_selected',
    };
  }

  const thresholdIds = getThresholdParticipantIds(candidateParticipants);
  if (!thresholdIds.length) {
    throw new Error('This candidate has no participants that met the configured minimum presence threshold.');
  }

  return {
    participantIds: thresholdIds,
    selectionSource: 'threshold_default',
  };
}

function resolveFinalizeParticipantSelection(candidateParticipants, {
  explicitParticipantIds = null,
  lockedParticipantIds = null,
} = {}) {
  const explicitIds = dedupeParticipantIds(explicitParticipantIds);
  if (explicitIds.length) {
    return {
      participantIds: validateCandidateParticipantIds(candidateParticipants, explicitIds),
      selectionSource: 'explicit_override',
    };
  }

  const lockinIds = dedupeParticipantIds(lockedParticipantIds);
  if (lockinIds.length) {
    return {
      participantIds: validateCandidateParticipantIds(candidateParticipants, lockinIds),
      selectionSource: 'lockin_draft',
    };
  }

  const thresholdIds = getThresholdParticipantIds(candidateParticipants);
  if (!thresholdIds.length) {
    throw new Error('This candidate has no participants that met the configured minimum presence threshold.');
  }

  return {
    participantIds: thresholdIds,
    selectionSource: 'threshold_default',
  };
}

module.exports = {
  resolveDraftParticipantSelection,
  resolveFinalizeParticipantSelection,
};
