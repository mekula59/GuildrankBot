function normalizeGameKey(input) {
  const normalized = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!normalized) {
    throw new Error('Game label must contain letters or numbers. Try values like `codm`, `among_us`, `gartic`, `general_gaming`, or `mixed`.');
  }

  if (normalized.length > 40) {
    throw new Error('Game label is too long after normalization. Keep it short and reusable.');
  }

  return normalized;
}

function normalizeTimezoneLabel(input) {
  if (input == null) return null;
  const normalized = String(input).trim();
  if (!normalized) return null;
  if (normalized.length > 80) {
    throw new Error('Timezone label must be 80 characters or fewer.');
  }
  return normalized;
}

function parseScheduledStartInput(input) {
  const normalized = String(input || '').trim();
  if (!normalized) {
    throw new Error('start_time is required.');
  }

  if (!/(z|[+\-]\d{2}:\d{2})$/i.test(normalized)) {
    throw new Error('start_time must include a UTC or timezone offset, for example `2026-05-01T17:00:00Z` or `2026-05-01T18:00:00+01:00`.');
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('start_time must be a valid ISO-8601 datetime.');
  }

  return parsed.toISOString();
}

module.exports = {
  normalizeGameKey,
  normalizeTimezoneLabel,
  parseScheduledStartInput,
};
