function resolveThresholdReachedAt(openSegments = [], minActiveMembers = 2) {
  if (!Array.isArray(openSegments) || openSegments.length < minActiveMembers) return null;

  const sorted = [...openSegments]
    .filter(segment => segment?.joined_at)
    .sort((left, right) => new Date(left.joined_at) - new Date(right.joined_at));

  if (sorted.length < minActiveMembers) return null;
  return new Date(sorted[minActiveMembers - 1].joined_at);
}

function mergePresenceIntervals(intervals = [], graceGapSeconds = 0) {
  if (!Array.isArray(intervals) || !intervals.length) return [];

  const graceMs = Math.max(0, graceGapSeconds) * 1000;
  const sorted = [...intervals]
    .map(interval => ({
      startedAt: new Date(interval.startedAt),
      endedAt: new Date(interval.endedAt),
    }))
    .filter(interval => interval.endedAt > interval.startedAt)
    .sort((left, right) => left.startedAt - right.startedAt);

  if (!sorted.length) return [];

  const merged = [sorted[0]];
  for (const interval of sorted.slice(1)) {
    const current = merged[merged.length - 1];
    if (interval.startedAt.getTime() <= current.endedAt.getTime() + graceMs) {
      if (interval.endedAt > current.endedAt) {
        current.endedAt = interval.endedAt;
      }
      continue;
    }

    merged.push(interval);
  }

  return merged;
}

function buildCandidateParticipantRows({
  sessionCandidateId,
  guildId,
  segments = [],
  startedAt,
  endedAt,
  minParticipantPresenceMinutes = 5,
  graceGapSeconds = 180,
}) {
  if (!sessionCandidateId) throw new Error('sessionCandidateId is required.');
  if (!guildId) throw new Error('guildId is required.');

  const windowStart = new Date(startedAt);
  const windowEnd = new Date(endedAt);
  const minPresenceSeconds = Math.max(1, minParticipantPresenceMinutes) * 60;
  const byUser = new Map();

  for (const segment of segments) {
    const rawStart = new Date(segment.joined_at);
    const rawEnd = segment.left_at ? new Date(segment.left_at) : windowEnd;
    const clippedStart = rawStart > windowStart ? rawStart : windowStart;
    const clippedEnd = rawEnd < windowEnd ? rawEnd : windowEnd;

    if (!(clippedEnd > clippedStart)) continue;

    const current = byUser.get(segment.discord_user_id) || [];
    current.push({ startedAt: clippedStart, endedAt: clippedEnd });
    byUser.set(segment.discord_user_id, current);
  }

  const rows = [];
  for (const [discordUserId, intervals] of byUser.entries()) {
    const mergedIntervals = mergePresenceIntervals(intervals, graceGapSeconds);
    if (!mergedIntervals.length) continue;

    const totalPresenceSeconds = mergedIntervals.reduce((sum, interval) => (
      sum + Math.max(0, Math.floor((interval.endedAt - interval.startedAt) / 1000))
    ), 0);

    const strongThresholdSeconds = Math.max(minPresenceSeconds * 2, 900);
    let candidateStrength = 'weak';
    if (totalPresenceSeconds >= strongThresholdSeconds) {
      candidateStrength = 'strong';
    } else if (totalPresenceSeconds >= minPresenceSeconds) {
      candidateStrength = 'borderline';
    }

    rows.push({
      session_candidate_id: sessionCandidateId,
      guild_id: guildId,
      discord_user_id: discordUserId,
      first_seen_at: mergedIntervals[0].startedAt.toISOString(),
      last_seen_at: mergedIntervals[mergedIntervals.length - 1].endedAt.toISOString(),
      total_presence_seconds: totalPresenceSeconds,
      overlap_seconds: totalPresenceSeconds,
      segment_count: intervals.length,
      met_presence_threshold: totalPresenceSeconds >= minPresenceSeconds,
      candidate_strength: candidateStrength,
      updated_at: new Date().toISOString(),
    });
  }

  return rows.sort((left, right) => {
    if (right.total_presence_seconds !== left.total_presence_seconds) {
      return right.total_presence_seconds - left.total_presence_seconds;
    }

    return left.discord_user_id.localeCompare(right.discord_user_id);
  });
}

module.exports = {
  buildCandidateParticipantRows,
  mergePresenceIntervals,
  resolveThresholdReachedAt,
};
