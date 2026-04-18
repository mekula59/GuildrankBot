const test = require('node:test');
const assert = require('node:assert/strict');

const { checkMutationThrottle, resetThrottleState } = require('../src/utils/throttle');
const { buildVcCreditDecision } = require('../src/utils/vcCredit');
const { getDigestKey } = require('../src/utils/digestKey');
const { readMigrationFiles } = require('../src/utils/migrations');
const {
  normalizeGameKey,
  parseScheduledStartInput,
} = require('../src/utils/scheduledSessionTime');
const { resolveScheduledSessionMatch } = require('../src/utils/scheduledSessionMatch');
const {
  buildCandidateParticipantRows,
  mergePresenceIntervals,
  resolveThresholdReachedAt,
} = require('../src/utils/sessionCandidateMath');
const {
  resolveDraftParticipantSelection,
  resolveFinalizeParticipantSelection,
} = require('../src/utils/sessionLockinRoster');

test.beforeEach(() => {
  resetThrottleState();
});

test('mutation throttle blocks rapid repeat calls', () => {
  const first = checkMutationThrottle({
    commandKey: 'session_log',
    guildId: 'guild-1',
    actorId: 'user-1',
    userWindowMs: 10_000,
    guildWindowMs: 3_000,
  });

  const second = checkMutationThrottle({
    commandKey: 'session_log',
    guildId: 'guild-1',
    actorId: 'user-1',
    userWindowMs: 10_000,
    guildWindowMs: 3_000,
  });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.scope, 'guild');
});

test('vc credit decision rejects solo farming and caps long sessions', () => {
  assert.deepEqual(buildVcCreditDecision(60, false), {
    rawDurationMinutes: 60,
    creditedMinutes: 0,
    antiFarmingReason: 'no_companion',
  });

  assert.deepEqual(buildVcCreditDecision(500, true), {
    rawDurationMinutes: 500,
    creditedMinutes: 240,
    antiFarmingReason: 'session_cap',
  });
});

test('weekly digest key is stable for a given week', () => {
  assert.equal(getDigestKey(new Date('2026-03-31T12:00:00.000Z')), '2026-03-30');
  assert.equal(getDigestKey(new Date('2026-04-05T23:59:00.000Z')), '2026-03-30');
});

test('migration bundle includes current schema extensions', () => {
  const versions = readMigrationFiles().map(file => file.version);
  assert.ok(versions.includes('000_base_schema'));
  assert.ok(versions.includes('003_phase15_guardrails'));
  assert.ok(versions.includes('006_vc_assisted_phase1_foundation'));
  assert.ok(versions.includes('007_vc_assisted_candidate_guardrails'));
  assert.ok(versions.includes('008_vc_assisted_finalize_discard'));
  assert.ok(versions.includes('009_vc_assisted_prerelease_guardrails'));
  assert.ok(versions.includes('010_vc_candidate_threshold_snapshots'));
  assert.ok(versions.includes('011_scheduled_sessions_slice1'));
  assert.ok(versions.includes('012_candidate_schedule_context'));
  assert.ok(versions.includes('013_session_lockin_drafts'));
});

test('threshold reached time comes from the nth active member join', () => {
  const thresholdReachedAt = resolveThresholdReachedAt([
    { joined_at: '2026-04-18T10:00:00.000Z' },
    { joined_at: '2026-04-18T10:03:00.000Z' },
    { joined_at: '2026-04-18T10:08:00.000Z' },
  ], 2);

  assert.equal(thresholdReachedAt?.toISOString(), '2026-04-18T10:03:00.000Z');
});

test('presence intervals merge across short churn gaps', () => {
  const merged = mergePresenceIntervals([
    { startedAt: '2026-04-18T10:00:00.000Z', endedAt: '2026-04-18T10:05:00.000Z' },
    { startedAt: '2026-04-18T10:06:00.000Z', endedAt: '2026-04-18T10:15:00.000Z' },
    { startedAt: '2026-04-18T10:30:00.000Z', endedAt: '2026-04-18T10:35:00.000Z' },
  ], 120);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].startedAt.toISOString(), '2026-04-18T10:00:00.000Z');
  assert.equal(merged[0].endedAt.toISOString(), '2026-04-18T10:15:00.000Z');
});

test('candidate participant aggregation labels strong and weak users correctly', () => {
  const rows = buildCandidateParticipantRows({
    sessionCandidateId: 'candidate-1',
    guildId: 'guild-1',
    startedAt: '2026-04-18T10:00:00.000Z',
    endedAt: '2026-04-18T10:30:00.000Z',
    minParticipantPresenceMinutes: 5,
    graceGapSeconds: 120,
    segments: [
      {
        discord_user_id: 'user-strong',
        joined_at: '2026-04-18T10:00:00.000Z',
        left_at: '2026-04-18T10:20:00.000Z',
      },
      {
        discord_user_id: 'user-weak',
        joined_at: '2026-04-18T10:25:00.000Z',
        left_at: '2026-04-18T10:27:00.000Z',
      },
    ],
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => ({ user: row.discord_user_id, strength: row.candidate_strength })), [
    { user: 'user-strong', strength: 'strong' },
    { user: 'user-weak', strength: 'weak' },
  ]);
});

test('scheduled session start parsing requires timezone-aware input and stores UTC', () => {
  assert.equal(
    parseScheduledStartInput('2026-05-01T18:00:00+01:00'),
    '2026-05-01T17:00:00.000Z'
  );

  assert.throws(
    () => parseScheduledStartInput('2026-05-01 17:00'),
    /UTC or timezone offset/
  );
});

test('scheduled session game labels normalize to reusable keys', () => {
  assert.equal(normalizeGameKey('General Gaming'), 'general_gaming');
  assert.equal(normalizeGameKey('Among-Us'), 'among_us');
});

test('candidate schedule matching links exactly one clean match', () => {
  const result = resolveScheduledSessionMatch([
    {
      id: 'schedule-1',
      guild_id: 'guild-1',
      status: 'scheduled',
      linked_channel_id: 'channel-1',
      game_key: 'codm',
      session_type: 'competitive',
      scheduled_start_at: '2026-05-01T17:00:00.000Z',
    },
    {
      id: 'schedule-2',
      guild_id: 'guild-1',
      status: 'scheduled',
      linked_channel_id: 'channel-2',
      game_key: 'among_us',
      session_type: 'casual',
      scheduled_start_at: '2026-05-01T17:00:00.000Z',
    },
  ], {
    channelId: 'channel-1',
    startedAt: '2026-05-01T17:20:00.000Z',
  });

  assert.equal(result.scheduleMatchStatus, 'matched');
  assert.equal(result.scheduledSession?.id, 'schedule-1');
  assert.equal(result.ambiguous, false);
});

test('candidate schedule matching stays unlinked when multiple schedules match', () => {
  const result = resolveScheduledSessionMatch([
    {
      id: 'schedule-1',
      guild_id: 'guild-1',
      status: 'scheduled',
      linked_channel_id: null,
      game_key: 'codm',
      session_type: 'competitive',
      scheduled_start_at: '2026-05-01T17:00:00.000Z',
    },
    {
      id: 'schedule-2',
      guild_id: 'guild-1',
      status: 'scheduled',
      linked_channel_id: null,
      game_key: 'mixed',
      session_type: 'casual',
      scheduled_start_at: '2026-05-01T17:15:00.000Z',
    },
  ], {
    channelId: 'channel-1',
    startedAt: '2026-05-01T17:20:00.000Z',
  });

  assert.equal(result.scheduleMatchStatus, 'ambiguous');
  assert.equal(result.scheduledSession, null);
  assert.equal(result.ambiguous, true);
  assert.equal(result.matchedCount, 2);
});

test('lock-in draft selection uses explicit admin roster when provided', () => {
  const result = resolveDraftParticipantSelection([
    { discord_user_id: 'user-1', met_presence_threshold: true },
    { discord_user_id: 'user-2', met_presence_threshold: false },
  ], ['user-2']);

  assert.deepEqual(result, {
    participantIds: ['user-2'],
    selectionSource: 'admin_selected',
  });
});

test('finalize selection prefers lock-in roster before threshold fallback', () => {
  const result = resolveFinalizeParticipantSelection([
    { discord_user_id: 'user-1', met_presence_threshold: true },
    { discord_user_id: 'user-2', met_presence_threshold: false },
  ], {
    lockedParticipantIds: ['user-2'],
  });

  assert.deepEqual(result, {
    participantIds: ['user-2'],
    selectionSource: 'lockin_draft',
  });
});
