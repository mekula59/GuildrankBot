function dedupeIds(ids = []) {
  return [...new Set((ids || []).filter(Boolean))];
}

function partitionCandidateRoster(candidateParticipants = [], lockedPlayerIds = []) {
  const observedIds = dedupeIds(candidateParticipants.map(row => row.discord_user_id));
  const observedSet = new Set(observedIds);
  const lockedIds = dedupeIds(lockedPlayerIds);
  const invalidLockedIds = lockedIds.filter(id => !observedSet.has(id));

  if (invalidLockedIds.length) {
    throw new Error(`These locked players are not part of the candidate pool: ${invalidLockedIds.map(id => `<@${id}>`).join(', ')}`);
  }

  const playerIds = lockedIds.length
    ? lockedIds
    : dedupeIds(
      candidateParticipants
        .filter(row => row.met_presence_threshold)
        .map(row => row.discord_user_id)
    );
  const playerSet = new Set(playerIds);
  const spectatorIds = observedIds.filter(id => !playerSet.has(id));

  return {
    playerIds,
    spectatorIds,
  };
}

function resolveLiveSessionRosterUpdate(existingPeople = [], {
  playerIds = undefined,
  spectatorIds = undefined,
} = {}) {
  const existingPlayers = dedupeIds(
    existingPeople
      .filter(row => row.roster_role === 'player')
      .map(row => row.discord_user_id)
  );
  const existingSpectators = dedupeIds(
    existingPeople
      .filter(row => row.roster_role === 'spectator')
      .map(row => row.discord_user_id)
  );

  const nextPlayers = playerIds !== undefined ? dedupeIds(playerIds) : existingPlayers;
  const nextSpectators = spectatorIds !== undefined ? dedupeIds(spectatorIds) : existingSpectators;

  if (playerIds !== undefined && spectatorIds === undefined) {
    const conflictIds = nextPlayers.filter(id => existingSpectators.includes(id));
    if (conflictIds.length) {
      throw new Error(`Players and spectators must stay disjoint. Update \`spectators\` too when moving these users into players: ${conflictIds.map(id => `<@${id}>`).join(', ')}`);
    }
  }

  if (spectatorIds !== undefined && playerIds === undefined) {
    const conflictIds = nextSpectators.filter(id => existingPlayers.includes(id));
    if (conflictIds.length) {
      throw new Error(`Players and spectators must stay disjoint. Update \`players\` too when moving these users into spectators: ${conflictIds.map(id => `<@${id}>`).join(', ')}`);
    }
  }

  const nextPlayerSet = new Set(nextPlayers);
  const overlapIds = nextSpectators.filter(id => nextPlayerSet.has(id));
  if (overlapIds.length) {
    throw new Error(`Players and spectators must be disjoint. Remove these users from one roster: ${overlapIds.map(id => `<@${id}>`).join(', ')}`);
  }

  return {
    playerIds: nextPlayers,
    spectatorIds: nextSpectators,
  };
}

module.exports = {
  partitionCandidateRoster,
  resolveLiveSessionRosterUpdate,
};
