function getSafeErrorMessage(error) {
  return String(error?.message || error || 'Unknown error').replace(/\s+/g, ' ').trim();
}

function includesAny(message, fragments) {
  const lower = String(message || '').toLowerCase();
  return fragments.some(fragment => lower.includes(fragment.toLowerCase()));
}

function hasPattern(message, patterns) {
  const lower = String(message || '').toLowerCase();
  return patterns.some(pattern => pattern.test(lower));
}

function isMissingMigrationOrConfigError(error, message) {
  const code = String(error?.code || '');
  if (['PGRST202', 'PGRST204', '42883', '42703', '42P01'].includes(code)) {
    return true;
  }

  return includesAny(message, [
    'could not find the function',
    'schema cache',
    'undefined_function',
    'undefined_column',
    'undefined_table',
  ]) || hasPattern(message, [
    /\bfunction\b.+\bdoes not exist\b/,
    /\brelation\b.+\bdoes not exist\b/,
    /\bcolumn\b.+\bdoes not exist\b/,
  ]);
}

function isDatabaseConflictError(error, message) {
  return error?.code === '23505'
    || error?.code === '23503'
    || error?.code === '23514'
    || includesAny(message, [
      'duplicate key',
      'violates unique constraint',
      'violates foreign key constraint',
      'violates check constraint',
      'attendance conflict',
    ]);
}

function classifyFinalizeError(error, sourceType) {
  const message = getSafeErrorMessage(error);

  if (
    message.startsWith('No valid @mentions were found')
    || message.startsWith('These mentioned users are not valid members')
    || message.startsWith('Mention exactly one user')
  ) {
    return 'mention_validation';
  }

  if (message.includes('already been finalized')) return 'already_finalized';
  if (message.includes('not found in this server')) return 'not_found';
  if (sourceType === 'live_session' && message.includes('Finalize only works after the live session has been ended')) return 'live_session_not_ended';
  if (message.includes('Live session finalize requires at least one player')) return 'missing_players';
  if (message.includes('Only closed session candidates can be finalized')) return 'candidate_not_closed';
  if (message.includes('already been discarded')) return 'candidate_discarded';
  if (message.includes('Winner must be included') || message.includes('MVP must be included')) return 'invalid_result_person';

  if (
    message.includes('Finalize can only use the current live-session player roster')
    || message.includes('One or more selected participants are not part of the candidate pool')
    || message.includes('At least one participant is required')
    || message.includes('Candidate participant rows are missing')
    || message.includes('Candidate participant snapshot is not ready')
  ) {
    return 'roster_invalid';
  }

  if (message.includes('scheduled session') || message.includes('Scheduled session')) return 'scheduled_session_problem';

  if (
    message.includes('request_id_conflict')
    || message.includes('already linked to another completed official session')
    || message.includes('linked candidate could not be consumed')
  ) {
    return 'duplicate_or_request_conflict';
  }

  if (isMissingMigrationOrConfigError(error, message)) return 'missing_schema_or_config';
  if (isDatabaseConflictError(error, message)) return 'database_conflict';

  return 'unknown';
}

function formatFinalizeFailureMessage(error, sourceType) {
  const message = getSafeErrorMessage(error);
  const sourceLabel = sourceType === 'live_session' ? 'live session' : 'detected session';
  const category = classifyFinalizeError(error, sourceType);

  if (category === 'mention_validation') {
    return `❌ ${message}`;
  }

  if (category === 'already_finalized') {
    return `❌ This ${sourceLabel} has already been finalized. No new official session was created.`;
  }

  if (category === 'not_found') {
    return `❌ That ${sourceLabel} was not found in this server. Refresh the autocomplete list and choose a current session.`;
  }

  if (category === 'live_session_not_ended') {
    return '❌ This live session is still running. Use `/session end` first, then run `/session finalize`.';
  }

  if (category === 'missing_players') {
    return '❌ This live session has no finalized players yet. Use `/session update` to add players before finalizing.';
  }

  if (category === 'candidate_not_closed') {
    return '❌ This detected session is not closed yet. Wait for it to close, or start a live session draft instead.';
  }

  if (category === 'candidate_discarded') {
    return '❌ This detected session was already discarded and cannot be finalized.';
  }

  if (category === 'invalid_result_person') {
    return `❌ ${message} Update the roster or choose a different winner/MVP before finalizing.`;
  }

  if (category === 'roster_invalid') {
    return `❌ Finalize could not use that roster. ${message}`;
  }

  if (category === 'scheduled_session_problem') {
    return `❌ Scheduled-session link problem: ${message}`;
  }

  if (category === 'duplicate_or_request_conflict') {
    return '❌ This finalize request conflicts with an official session that already exists. Refresh the session list and verify whether it was already finalized.';
  }

  if (category === 'missing_schema_or_config') {
    return '❌ Finalize could not run because the database schema or runtime config is not ready. Apply the latest GuildRank migrations, redeploy, then retry.';
  }

  if (category === 'database_conflict') {
    return '❌ Finalize hit a database integrity conflict while saving the official event or attendance. No duplicate reward should be issued. Refresh the session state and check Railway logs.';
  }

  return [
    '❌ Finalize failed before GuildRank could finish.',
    'Check Railway logs for `session_finalize_failed` and verify session status before retrying.',
  ].join('\n');
}

module.exports = {
  classifyFinalizeError,
  formatFinalizeFailureMessage,
  getSafeErrorMessage,
};
