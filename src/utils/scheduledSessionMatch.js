const {
  SCHEDULE_MATCH_BEFORE_START_MINUTES,
  SCHEDULE_MATCH_AFTER_START_MINUTES,
} = require('../../config/constants');

function resolveScheduledSessionMatch(scheduledSessions = [], {
  channelId = null,
  startedAt,
} = {}) {
  const candidateStart = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(candidateStart.getTime())) {
    throw new Error('startedAt must be a valid date for schedule matching.');
  }

  const matched = (scheduledSessions || []).filter(session => {
    if (!session?.scheduled_start_at || session.status !== 'scheduled') return false;
    if (session.linked_channel_id && session.linked_channel_id !== channelId) return false;

    const scheduledStart = new Date(session.scheduled_start_at);
    const diffMinutes = (candidateStart.getTime() - scheduledStart.getTime()) / 60000;
    return diffMinutes >= -SCHEDULE_MATCH_BEFORE_START_MINUTES
      && diffMinutes <= SCHEDULE_MATCH_AFTER_START_MINUTES;
  });

  if (!matched.length) {
    return {
      scheduledSession: null,
      scheduleMatchStatus: 'none',
      ambiguous: false,
      matchedCount: 0,
    };
  }

  if (matched.length > 1) {
    return {
      scheduledSession: null,
      scheduleMatchStatus: 'ambiguous',
      ambiguous: true,
      matchedCount: matched.length,
    };
  }

  return {
    scheduledSession: matched[0],
    scheduleMatchStatus: 'matched',
    ambiguous: false,
    matchedCount: 1,
  };
}

module.exports = {
  resolveScheduledSessionMatch,
};
