const test = require('node:test');
const assert = require('node:assert/strict');

const { checkMutationThrottle, resetThrottleState } = require('../src/utils/throttle');
const { buildVcCreditDecision } = require('../src/utils/vcCredit');
const { getDigestKey } = require('../src/utils/digestKey');
const {
  assignParticipantRewardRoles,
  buildRewardBuckets,
  buildRewardParticipantIds,
  formatRewardSummary,
} = require('../src/utils/participantRewards');
const {
  classifyFinalizeError,
  formatFinalizeFailureMessage,
} = require('../src/utils/finalizeErrorMessages');
const {
  DEFAULT_DIGEST_TIME_UTC,
  shouldSendDigestForConfig,
} = require('../src/utils/weeklyDigestSchedule');
const { normalizeGuildRuntimeConfig } = require('../src/utils/guildRuntimeConfig');
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
const {
  applyConfirmationToRoster,
  isDraftResultHolder,
  partitionCandidateRoster,
  resolveLiveSessionRosterUpdate,
} = require('../src/utils/liveSessionRoster');

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

test('guild runtime config falls back to announce channel for digest and badges', () => {
  const config = normalizeGuildRuntimeConfig({
    guild_id: 'guild-1',
    announce_channel_id: 'announce-1',
    operator_role_ids: ['role-1', 'role-1', null, ''],
  });

  assert.equal(config.badge_channel_id, 'announce-1');
  assert.equal(config.digest_channel_id, 'announce-1');
  assert.deepEqual(config.operator_role_ids, ['role-1']);
  assert.equal(config.game_catalog_enabled, false);
  assert.equal(config.participant_reward_enabled, false);
  assert.equal(config.participant_reward_scope, 'players_only');
  assert.equal(config.player_reward_role_id, null);
  assert.equal(config.spectator_reward_role_id, null);
});

test('weekly digest preserves default UTC send time and supports configured time', () => {
  assert.equal(DEFAULT_DIGEST_TIME_UTC, '20:00');
  assert.equal(shouldSendDigestForConfig({
    guild_id: 'guild-1',
    digest_day: 'friday',
  }, new Date('2026-05-01T20:00:00.000Z')), true);

  assert.equal(shouldSendDigestForConfig({
    guild_id: 'guild-1',
    digest_day: 'friday',
  }, new Date('2026-05-01T19:59:00.000Z')), false);

  assert.equal(shouldSendDigestForConfig({
    guild_id: 'guild-1',
    digest_day: 'friday',
    digest_time_utc: '18:30',
  }, new Date('2026-05-01T18:30:00.000Z')), true);
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
  assert.ok(versions.includes('014_live_sessions'));
  assert.ok(versions.includes('015_guild_runtime_config'));
  assert.ok(versions.includes('016_live_session_checkins'));
  assert.ok(versions.includes('017_participant_reward_roles'));
  assert.ok(versions.includes('018_separate_player_viewer_rewards'));
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

test('live session roster preloads lock-in players and keeps the rest as spectators', () => {
  const result = partitionCandidateRoster([
    { discord_user_id: 'user-1', met_presence_threshold: true },
    { discord_user_id: 'user-2', met_presence_threshold: true },
    { discord_user_id: 'user-3', met_presence_threshold: false },
  ], ['user-2']);

  assert.deepEqual(result, {
    playerIds: ['user-2'],
    spectatorIds: ['user-1', 'user-3'],
  });
});

test('live session roster update preserves omitted role and rejects overlap', () => {
  assert.throws(() => resolveLiveSessionRosterUpdate([
    { roster_role: 'player', discord_user_id: 'user-1' },
    { roster_role: 'spectator', discord_user_id: 'user-2' },
  ], {
    playerIds: ['user-1', 'user-2'],
  }), /Players and spectators must stay disjoint/);

  const result = resolveLiveSessionRosterUpdate([
    { roster_role: 'player', discord_user_id: 'user-1' },
    { roster_role: 'spectator', discord_user_id: 'user-2' },
  ], {
    spectatorIds: ['user-3'],
  });

  assert.deepEqual(result, {
    playerIds: ['user-1'],
    spectatorIds: ['user-3'],
  });
});

test('live session check-in moves one member without duplicating roster roles', () => {
  const playing = applyConfirmationToRoster([
    { roster_role: 'spectator', discord_user_id: 'user-1' },
    { roster_role: 'player', discord_user_id: 'user-2' },
  ], 'user-1', 'playing');

  assert.deepEqual(playing.map(row => ({ role: row.roster_role, user: row.discord_user_id })), [
    { role: 'player', user: 'user-2' },
    { role: 'player', user: 'user-1' },
  ]);

  const removed = applyConfirmationToRoster(playing, 'user-1', 'not_in_session');

  assert.deepEqual(removed.map(row => ({ role: row.roster_role, user: row.discord_user_id })), [
    { role: 'player', user: 'user-2' },
  ]);
});

test('live session check-in result guard only blocks the current winner or MVP', () => {
  const liveSession = {
    winner_discord_user_id: 'winner-1',
    mvp_discord_user_id: 'mvp-1',
  };

  assert.equal(isDraftResultHolder(liveSession, 'spectator-1'), false);
  assert.equal(isDraftResultHolder(liveSession, 'winner-1'), true);
  assert.equal(isDraftResultHolder(liveSession, ' mvp-1 '), true);
  assert.equal(isDraftResultHolder({
    winner_discord_user_id: null,
    mvp_discord_user_id: '',
  }, 'spectator-1'), false);
});

test('participant rewards default to finalized players only', () => {
  assert.deepEqual(buildRewardParticipantIds({
    participantIds: ['user-1', 'user-2', 'user-1'],
    people: [
      { discord_user_id: 'spectator-1', roster_role: 'spectator' },
    ],
    scope: 'players_only',
  }), ['user-1', 'user-2']);

  assert.deepEqual(buildRewardParticipantIds({
    participantIds: ['user-1'],
    people: [
      { discord_user_id: 'spectator-1', roster_role: 'spectator' },
      { discord_user_id: 'user-1', roster_role: 'player' },
    ],
    scope: 'players_and_spectators',
  }), ['user-1', 'spectator-1']);
});

test('participant reward scopes choose the expected roster members', () => {
  const people = [
    { discord_user_id: 'player-1', roster_role: 'player' },
    { discord_user_id: 'spectator-1', roster_role: 'spectator' },
    { discord_user_id: 'spectator-2', roster_role: 'spectator' },
  ];

  assert.deepEqual(buildRewardParticipantIds({
    participantIds: ['player-1'],
    people,
    scope: 'spectators_only',
  }), ['spectator-1', 'spectator-2']);

  assert.deepEqual(buildRewardParticipantIds({
    participantIds: ['player-1'],
    people,
    scope: 'players_and_spectators',
  }), ['player-1', 'spectator-1', 'spectator-2']);

  assert.deepEqual(buildRewardBuckets({
    participantIds: ['player-1'],
    people,
    config: {
      participant_reward_scope: 'players_and_spectators',
      participant_reward_role_id: 'shared-role',
      player_reward_role_id: null,
      spectator_reward_role_id: null,
    },
  }), [
    { label: 'players and spectators', roleId: 'shared-role', userIds: ['player-1', 'spectator-1', 'spectator-2'] },
  ]);

  assert.deepEqual(buildRewardBuckets({
    participantIds: ['player-1'],
    people,
    config: {
      participant_reward_scope: 'separate_roles',
      player_reward_role_id: 'player-role',
      spectator_reward_role_id: 'viewer-role',
    },
  }), [
    { label: 'players', roleId: 'player-role', userIds: ['player-1'] },
    { label: 'spectators', roleId: 'viewer-role', userIds: ['spectator-1', 'spectator-2'] },
  ]);
});

test('participant reward role assignment skips bots and keeps finalize non-blocking', async () => {
  const added = [];
  const makeMember = (id, bot = false) => ({
    id,
    user: { bot },
    roles: {
      cache: { has: () => false },
      add: async roleId => { added.push(`${id}:${roleId}`); },
    },
  });
  const members = new Map([
    ['player-1', makeMember('player-1')],
    ['spectator-1', makeMember('spectator-1')],
    ['bot-1', makeMember('bot-1', true)],
  ]);
  const roles = new Map([
    ['player-role', { id: 'player-role' }],
    ['viewer-role', { id: 'viewer-role' }],
  ]);
  const guild = {
    roles: {
      cache: roles,
      fetch: async id => roles.get(id) || null,
    },
    members: {
      me: {
        permissions: { has: () => true },
        roles: { highest: { comparePositionTo: () => 1 } },
      },
      cache: members,
      fetch: async id => members.get(id) || null,
    },
  };

  const summary = await assignParticipantRewardRoles({
    guild,
    guildId: 'guild-1',
    config: {
      participant_reward_enabled: true,
      participant_reward_scope: 'separate_roles',
      player_reward_role_id: 'player-role',
      spectator_reward_role_id: 'viewer-role',
    },
    participantIds: ['player-1', 'bot-1'],
    people: [
      { discord_user_id: 'spectator-1', roster_role: 'spectator' },
    ],
  });

  assert.equal(summary.assigned, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(added, ['player-1:player-role', 'spectator-1:viewer-role']);

  const missingRoleSummary = await assignParticipantRewardRoles({
    guild,
    guildId: 'guild-1',
    config: {
      participant_reward_enabled: true,
      participant_reward_scope: 'separate_roles',
      player_reward_role_id: null,
      spectator_reward_role_id: 'viewer-role',
    },
    participantIds: ['player-1'],
    people: [
      { discord_user_id: 'spectator-1', roster_role: 'spectator' },
    ],
  });

  assert.equal(missingRoleSummary.assigned, 1);
  assert.match(formatRewardSummary(missingRoleSummary), /No reward role is configured for players/);
});

test('participant reward summary explains disabled and permission states', () => {
  assert.equal(formatRewardSummary({ enabled: false }), 'Participant reward role is disabled.');
  assert.match(formatRewardSummary({
    enabled: true,
    roleId: 'role-1',
    assigned: 0,
    skipped: 0,
    failed: 0,
    warnings: ['GuildRank cannot assign the players reward role yet. Give the bot Manage Roles and move the GuildRank bot role above the reward role.'],
  }), /Manage Roles/);
});

test('finalize error mapping only reports missing schema for real schema errors', () => {
  assert.equal(
    classifyFinalizeError({ code: 'PGRST202', message: 'Could not find the function public.finalize_live_session in the schema cache' }, 'live_session'),
    'missing_schema_or_config'
  );

  assert.equal(
    classifyFinalizeError({ message: 'DiscordAPIError[10011]: Unknown Role' }, 'live_session'),
    'unknown'
  );

  assert.equal(
    classifyFinalizeError({ message: 'Reward role does not exist in this guild.' }, 'live_session'),
    'unknown'
  );

  assert.doesNotMatch(
    formatFinalizeFailureMessage({ message: 'Reward role does not exist in this guild.' }, 'live_session'),
    /migrations/i
  );

  assert.match(
    formatFinalizeFailureMessage({ code: '23505', message: 'duplicate key value violates unique constraint "events_request_id_key"' }, 'live_session'),
    /database integrity conflict/
  );
});
