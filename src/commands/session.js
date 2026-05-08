const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  ChannelType,
} = require('discord.js');

const { isSetup, getGuildConfig } = require('../utils/guilds');
const { recordManualSession, voidManualSession } = require('../utils/stats');
const {
  discardSessionCandidate,
  finalizeSessionCandidate,
  getSessionCandidateById,
  listCandidateParticipants,
  listSessionCandidates,
} = require('../utils/sessionCandidates');
const {
  cancelScheduledSession,
  createScheduledSession,
  getScheduledSessionById,
  getScheduledSessionsByIds,
  listUpcomingScheduledSessions,
  rescheduleScheduledSession,
} = require('../utils/scheduledSessions');
const {
  getLockinDraftWithPlayers,
  upsertSessionLockinDraft,
} = require('../utils/sessionLockins');
const {
  endLiveSession,
  finalizeLiveSession,
  getLiveSessionWithPeople,
  listLiveSessions,
  startLiveSession,
  updateLiveSession,
} = require('../utils/liveSessions');
const {
  listLiveSessionConfirmations,
  recordLiveSessionConfirmation,
  setLiveSessionCheckinStatus,
} = require('../utils/liveSessionCheckins');
const {
  assignParticipantRewardRoles,
  formatRewardSummary,
} = require('../utils/participantRewards');
const {
  classifyFinalizeError,
  formatFinalizeFailureMessage,
  getSafeErrorMessage,
} = require('../utils/finalizeErrorMessages');
const { checkMutationThrottle } = require('../utils/throttle');
const logger = require('../utils/logger');
const { BRAND_COLOR } = require('../../config/constants');

const CANDIDATE_STATUS_CHOICES = [
  { name: 'Open', value: 'open' },
  { name: 'Closed', value: 'closed' },
  { name: 'All active', value: 'all_active' },
];

function clampAutocompleteText(value, maxLength = 100) {
  const text = String(value || '').replace(/\s+/g, ' ').trim() || 'Session';
  const chars = Array.from(text);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : text;
}

function extractMentionedUserIds(content) {
  return [...new Set([...content.matchAll(/<@!?(\d+)>/g)].map(match => match[1]))];
}

function getRenamedStringOption(interaction, preferredName, legacyNames = [], required = false) {
  const fallbacks = Array.isArray(legacyNames) ? legacyNames : [legacyNames].filter(Boolean);
  let value = interaction.options.getString(preferredName);
  for (const legacyName of fallbacks) {
    value ??= interaction.options.getString(legacyName);
  }
  if (required && !value) {
    throw new Error(`Missing required option \`${preferredName}\`.`);
  }
  return value;
}

async function resolveMentionedGuildUserIds(interaction, content, {
  fieldName = 'players',
  requireSingle = false,
} = {}) {
  const mentionedIds = extractMentionedUserIds(content);
  if (!mentionedIds.length) {
    throw new Error(`No valid @mentions were found in \`${fieldName}\`.`);
  }

  const resolvedIds = [];
  const invalidIds = [];

  for (const userId of mentionedIds) {
    try {
      const member = interaction.guild.members.cache.get(userId) || await interaction.guild.members.fetch(userId);
      if (!member?.user?.bot) {
        resolvedIds.push(member.id);
      } else {
        invalidIds.push(userId);
      }
    } catch {
      invalidIds.push(userId);
    }
  }

  if (invalidIds.length) {
    throw new Error(`These mentioned users are not valid members of this server: ${invalidIds.map(id => `<@${id}>`).join(', ')}`);
  }

  if (requireSingle && resolvedIds.length !== 1) {
    throw new Error(`Mention exactly one user in \`${fieldName}\`.`);
  }

  return resolvedIds;
}

function requiresManageGuild(subcommand) {
  return ['correct'].includes(subcommand);
}

function requiresPrivateReply(subcommand) {
  return [
    'candidates',
    'candidate',
    'detected_sessions',
    'detected_session',
    'lockin',
    'start',
    'update',
    'end',
    'checkin_open',
    'checkin_close',
    'checkin_summary',
    'finalize',
    'discard',
    'schedule',
    'upcoming',
    'cancel',
    'reschedule',
  ].includes(subcommand);
}

function resolveAutocompleteSubcommand(interaction) {
  return interaction.options.getSubcommand(false) || interaction.options.data?.[0]?.name || null;
}

function hasAutocompletePermission(interaction, requiredPermission) {
  if (interaction.memberPermissions?.has?.(requiredPermission)) {
    return true;
  }

  const rawPermissions = interaction.member?.permissions;
  if (rawPermissions?.has?.(requiredPermission)) {
    return true;
  }

  try {
    if (typeof rawPermissions === 'string' && /^\d+$/.test(rawPermissions)) {
      return new PermissionsBitField(BigInt(rawPermissions)).has(requiredPermission);
    }

    if (typeof rawPermissions === 'bigint' || typeof rawPermissions === 'number') {
      return new PermissionsBitField(BigInt(rawPermissions)).has(requiredPermission);
    }
  } catch {
    return false;
  }

  return false;
}

function formatStatus(status) {
  return status.replaceAll('_', ' ');
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function formatUtcDateTime(value) {
  if (!value) return '—';
  return new Date(value).toISOString().replace('.000Z', 'Z');
}

function formatDurationMinutes(startedAt, endedAt = null) {
  if (!startedAt) return '—';
  const start = new Date(startedAt);
  const end = endedAt ? new Date(endedAt) : new Date();
  const minutes = Math.max(0, Math.round((end - start) / 60000));
  return `${minutes}m`;
}

function formatCandidateDisplayStamp(value) {
  if (!value) return 'unknown_time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown_time';
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function formatShortUtcStamp(value) {
  if (!value) return 'unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()];
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day} ${hour}:${minute} UTC`;
}

function resolveCachedChannelName(guild, channelId, fallback = 'Unlinked VC') {
  if (!channelId) return fallback;
  return guild?.channels?.cache?.get(channelId)?.name || fallback;
}

async function withAutocompleteTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function respondAutocompleteChoices(interaction, choices, context = {}) {
  const safeChoices = choices
    .map(choice => ({
      name: clampAutocompleteText(choice.name),
      value: String(choice.value || '').slice(0, 100),
    }))
    .filter(choice => choice.name && choice.value);

  try {
    return await interaction.respond(safeChoices.slice(0, 25));
  } catch (error) {
    logger.error('session_autocomplete_respond_failed', {
      request_id: interaction.id,
      guild_id: interaction.guildId,
      actor_id: interaction.user?.id,
      choice_count: safeChoices.length,
      ...context,
      error,
    });
    return interaction.respond([]).catch(() => {});
  }
}

function buildCandidateDisplayLabel(candidate) {
  return `${candidate.channel_name_snapshot || 'Voice Channel'} · ${formatShortUtcStamp(candidate.started_at)} · ${candidate.status || 'unknown'} · game fallback: ${candidate.game_key || 'session'}`;
}

function buildCandidateAutocompleteName(candidate) {
  return clampAutocompleteText(buildCandidateDisplayLabel(candidate));
}

function buildCandidateSearchText(candidate) {
  return [
    candidate.id,
    candidate.game_key,
    candidate.channel_name_snapshot,
    candidate.status,
    formatCandidateDisplayStamp(candidate.started_at),
  ].filter(Boolean).join(' ').toLowerCase();
}

function truncate(text, maxLength = 1024) {
  if (!text) return '—';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function buildScheduleSummaryLine(session) {
  return [
    `ID: \`${session.id}\``,
    `Game: \`${session.game_key}\``,
    `Type: \`${session.session_type}\``,
    `Start: ${formatUtcDateTime(session.scheduled_start_at)}`,
    `Timezone: ${session.input_timezone || 'UTC'}`,
    `VC: ${session.linked_channel_id ? `<#${session.linked_channel_id}>` : '—'}`,
    `Host: ${session.host_discord_user_id ? `<@${session.host_discord_user_id}>` : '—'}`,
    `Status: \`${session.status}\``,
  ].join('\n');
}

function buildScheduleAutocompleteName(session, guild = null) {
  const parts = [
    resolveCachedChannelName(guild, session.linked_channel_id),
    session.game_key || 'session',
    formatShortUtcStamp(session.scheduled_start_at),
    session.status || 'scheduled',
  ];

  return clampAutocompleteText(parts.join(' · '));
}

function buildScheduleSearchText(session) {
  return [
    session.id,
    session.game_key,
    session.session_type,
    session.linked_channel_id,
    session.host_discord_user_id,
    session.status,
    formatCandidateDisplayStamp(session.scheduled_start_at),
  ].filter(Boolean).join(' ').toLowerCase();
}

function formatCandidateScheduleContext(candidate, scheduledSession = null) {
  if (candidate.schedule_match_status === 'matched' && scheduledSession) {
    return [
      `Matched schedule: \`${scheduledSession.id}\``,
      `Planned game: \`${scheduledSession.game_key}\``,
      `Planned type: \`${scheduledSession.session_type}\``,
      `Planned start: ${formatUtcDateTime(scheduledSession.scheduled_start_at)}`,
      `Linked VC: ${scheduledSession.linked_channel_id ? `<#${scheduledSession.linked_channel_id}>` : '—'}`,
      'Context type: evidence only',
    ].join('\n');
  }

  if (candidate.schedule_match_status === 'matched') {
    return `Matched schedule: \`${candidate.scheduled_session_id}\`\nSchedule details are no longer available, but the detected session kept the evidence link.\nContext type: evidence only`;
  }

  if (candidate.schedule_match_status === 'ambiguous') {
    return 'Multiple scheduled sessions matched this detected session by time window, so GuildRank did not auto-link one.';
  }

  return 'No single scheduled session matched this detected session automatically.';
}

function buildCandidateSummaryLine(candidate, scheduledSession = null) {
  const scheduleLine = candidate.schedule_match_status === 'matched' && scheduledSession
    ? `Schedule: \`${scheduledSession.id}\` · ${scheduledSession.game_key} · ${formatUtcDateTime(scheduledSession.scheduled_start_at)}`
    : candidate.schedule_match_status === 'matched'
      ? `Schedule: \`${candidate.scheduled_session_id}\``
    : candidate.schedule_match_status === 'ambiguous'
      ? 'Schedule: ambiguous auto-match'
      : 'Schedule: none';

  return [
    `Detected session: ${buildCandidateDisplayLabel(candidate)}`,
    `Channel: <#${candidate.channel_id}>`,
    `Game fallback: \`${candidate.game_key}\``,
    'Game fallback means the tracked VC default or schedule context, not final event truth.',
    `Status: \`${candidate.status}\``,
    `Window: ${formatDateTime(candidate.started_at)} → ${candidate.ended_at ? formatDateTime(candidate.ended_at) : 'live'}`,
    `Duration: ${formatDurationMinutes(candidate.started_at, candidate.ended_at)}`,
    `Members: ${candidate.detected_member_count}`,
    scheduleLine,
  ].join('\n');
}

function buildCandidateParticipantLines(participants) {
  if (!participants.length) return ['No participant rows yet.'];

  return participants.slice(0, 12).map(row => (
    `• <@${row.discord_user_id}> · ${Math.round((row.total_presence_seconds || 0) / 60)}m · ${row.candidate_strength} · ${row.met_presence_threshold ? 'meets floor' : 'below floor'}`
  ));
}

function formatLockinSelectionSource(selectionSource) {
  if (!selectionSource) return '—';
  return formatStatus(selectionSource);
}

function buildLiveSessionDisplayLabel(liveSession) {
  return `${liveSession.channel_name_snapshot || 'Voice Channel'} · ${liveSession.game_key || 'session'} · ${formatShortUtcStamp(liveSession.started_at)} · ${liveSession.status || 'unknown'}`;
}

function buildLiveSessionAutocompleteName(liveSession) {
  return clampAutocompleteText(buildLiveSessionDisplayLabel(liveSession));
}

function buildLiveSessionSearchText(liveSession) {
  return [
    liveSession.id,
    liveSession.game_key,
    liveSession.channel_name_snapshot,
    liveSession.channel_id,
    liveSession.status,
    liveSession.start_context_type,
    formatCandidateDisplayStamp(liveSession.started_at),
  ].filter(Boolean).join(' ').toLowerCase();
}

function formatLiveSessionPeople(people, rosterRole) {
  const ids = people
    .filter(row => row.roster_role === rosterRole)
    .map(row => `<@${row.discord_user_id}>`);
  return ids.length ? ids.join(', ') : '—';
}

function buildCheckinCustomId(liveSessionId, response) {
  return `gr_checkin:${response}:${liveSessionId}`;
}

function parseCheckinCustomId(customId) {
  const [prefix, response, liveSessionId] = String(customId || '').split(':');
  if (prefix !== 'gr_checkin' || !response || !liveSessionId) return null;
  if (!['playing', 'spectating', 'not_in_session'].includes(response)) return null;
  return { response, liveSessionId };
}

function buildCheckinButtons(liveSessionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCheckinCustomId(liveSessionId, 'playing'))
      .setLabel('✅ Playing')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(buildCheckinCustomId(liveSessionId, 'spectating'))
      .setLabel('👀 Spectating')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildCheckinCustomId(liveSessionId, 'not_in_session'))
      .setLabel('❌ Not in this session')
      .setStyle(ButtonStyle.Danger),
  );
}

function formatConfirmationPeople(confirmations, response) {
  const ids = confirmations
    .filter(row => row.response === response)
    .map(row => `<@${row.discord_user_id}>`);
  return ids.length ? ids.join(', ') : '—';
}

async function buildCheckinSummaryFields(guildId, liveSession, people) {
  const confirmations = await listLiveSessionConfirmations(guildId, liveSession.id);
  let noResponse = [];

  if (liveSession.source_candidate_id) {
    const participants = await listCandidateParticipants(liveSession.source_candidate_id, guildId);
    const responded = new Set(confirmations.map(row => row.discord_user_id));
    noResponse = participants
      .map(row => row.discord_user_id)
      .filter(id => !responded.has(id));
  }

  return [
    { name: 'Confirmed Players', value: truncate(formatConfirmationPeople(confirmations, 'playing')) },
    { name: 'Confirmed Spectators', value: truncate(formatConfirmationPeople(confirmations, 'spectating')) },
    { name: 'Not In Session', value: truncate(formatConfirmationPeople(confirmations, 'not_in_session')) },
    { name: 'No Response Yet', value: truncate(noResponse.length ? noResponse.map(id => `<@${id}>`).join(', ') : '—') },
    { name: 'Current Draft Players', value: truncate(formatLiveSessionPeople(people, 'player')) },
    { name: 'Current Draft Spectators', value: truncate(formatLiveSessionPeople(people, 'spectator')) },
  ];
}

function buildLiveSessionSummaryLine(liveSession, people = []) {
  return [
    `Live Session: ${buildLiveSessionDisplayLabel(liveSession)}`,
    `Channel: <#${liveSession.channel_id}>`,
    `Game: \`${liveSession.game_key}\``,
    `Type: \`${liveSession.session_type}\``,
    `Started: ${formatUtcDateTime(liveSession.started_at)}`,
    `Ended: ${liveSession.ended_at ? formatUtcDateTime(liveSession.ended_at) : 'live'}`,
    `Players: ${people.filter(row => row.roster_role === 'player').length}`,
    `Spectators: ${people.filter(row => row.roster_role === 'spectator').length}`,
    `Winner: ${liveSession.winner_discord_user_id ? `<@${liveSession.winner_discord_user_id}>` : '—'}`,
    `MVP: ${liveSession.mvp_discord_user_id ? `<@${liveSession.mvp_discord_user_id}>` : '—'}`,
    `Source: \`${formatStatus(liveSession.start_context_type)}\``,
    `Detected session context: ${liveSession.source_candidate_id ? 'linked' : '—'}`,
    `Schedule context: ${liveSession.scheduled_session_id ? 'linked' : '—'}`,
  ].join('\n');
}

function buildLiveSessionStartSourceFields(result) {
  const fields = [];

  if (result.sourceCandidate) {
    fields.push({
      name: 'Source Detected Session',
      value: truncate(`${buildCandidateDisplayLabel(result.sourceCandidate)}\nThe detected-session game is a fallback label only.`),
    });
  } else if (result.sourceScheduledSession) {
    fields.push({
      name: 'Source Planned Session',
      value: truncate(`${buildScheduleAutocompleteName(result.sourceScheduledSession)}\nThe planned game is starting context only.`),
    });
  } else {
    fields.push({
      name: 'Source Channel',
      value: `<#${result.liveSession.channel_id}>`,
    });
  }

  fields.push({
    name: 'Live Draft Game',
    value: `\`${result.liveSession.game_key}\`\nThis editable label is what finalize will use.`,
    inline: false,
  });

  return fields;
}

function getLiveSessionStartDuplicateMessage(error) {
  const message = String(error?.message || '');
  if (message.includes('already has a live session draft')) {
    return [
      '❌ This detected session already has a live session draft.',
      'Finalize or discard the existing draft before starting another one.',
    ].join('\n');
  }

  if (
    message.includes('already a live session running')
    || message.includes('already running for this channel')
    || message.includes('already exists for that source or channel')
  ) {
    return [
      '❌ A live session is already running for this channel.',
      'End the current live session before starting another one.',
    ].join('\n');
  }

  return null;
}

function getLiveSessionStartFailureMessage(error) {
  const knownMessage = getLiveSessionStartDuplicateMessage(error);
  if (knownMessage) return knownMessage;

  const message = String(error?.message || '');
  const safeStartFailures = [
    'Choose a closed candidate, a scheduled session, or a tracked voice channel to start a live session.',
    'When starting from a candidate, do not also pass a schedule or channel.',
    'Session candidate not found in this server.',
    'Live sessions can start only from closed candidates in this slice.',
    'Scheduled session not found in this server.',
    'Live sessions can only start from scheduled sessions that are still scheduled.',
    'The selected channel does not match the scheduled session voice channel.',
    'This scheduled session does not have a linked voice channel. Provide a voice channel to start the live session.',
    'That voice channel is not currently tracked and enabled for live sessions.',
  ];

  if (safeStartFailures.includes(message)) {
    return `❌ Live session was not started.\n${message}`;
  }

  return [
    '❌ Live session was not started.',
    'No live-session draft was created. Try again, then check staging logs if it repeats.',
  ].join('\n');
}

async function getFinalizeSourceSafeStatus(guildId, sourceType, sourceId) {
  try {
    if (sourceType === 'live_session') {
      const result = await getLiveSessionWithPeople(guildId, sourceId);
      return result.liveSession?.status || 'not_found';
    }

    const candidate = await getSessionCandidateById(guildId, sourceId);
    return candidate?.status || 'not_found';
  } catch {
    return 'status_lookup_failed';
  }
}

async function logFinalizeFailure(interaction, {
  sourceType,
  sourceId,
  error,
}) {
  const safeStatus = sourceId
    ? await getFinalizeSourceSafeStatus(interaction.guildId, sourceType, sourceId)
    : 'no_source';

  logger.error('session_finalize_failed', {
    request_id: interaction.id,
    guild_id: interaction.guildId,
    actor_id: interaction.user.id,
    command: 'session finalize',
    source_type: sourceType,
    safe_status: safeStatus,
    error_category: classifyFinalizeError(error, sourceType),
    error_code: error?.code || error?.status || error?.name || null,
    error_message: getSafeErrorMessage(error),
  });
}

async function assignFinalizeRewardRolesOrWarn(interaction, {
  participantIds,
  people = [],
  source,
  sourceType,
}) {
  try {
    return await assignParticipantRewardRoles({
      guild: interaction.guild,
      guildId: interaction.guildId,
      config: await getGuildConfig(interaction.guildId),
      participantIds,
      people,
      source,
    });
  } catch (error) {
    logger.error('session_finalize_reward_failed', {
      request_id: interaction.id,
      guild_id: interaction.guildId,
      actor_id: interaction.user.id,
      command: 'session finalize',
      source_type: sourceType,
      error_category: 'reward_assignment_failed',
      error_code: error?.code || error?.status || error?.name || null,
      error_message: getSafeErrorMessage(error),
    });

    return {
      enabled: true,
      scope: 'unknown',
      roleId: null,
      playerRoleId: null,
      spectatorRoleId: null,
      assigned: 0,
      skipped: 0,
      failed: 0,
      reason: 'reward_assignment_failed',
      warnings: ['Official finalize succeeded, but reward role assignment could not run. Check reward role setup and Railway logs.'],
    };
  }
}

function formatLockedRoster(lockinDraft, lockinPlayers) {
  if (!lockinDraft || !lockinPlayers.length) {
    return 'No admin lock-in draft saved yet.';
  }

  return [
    `Draft ID: \`${lockinDraft.id}\``,
    `Locked by: <@${lockinDraft.locked_by_discord_user_id}>`,
    `Selection source: \`${formatLockinSelectionSource(lockinDraft.selection_source)}\``,
    `Updated: ${formatUtcDateTime(lockinDraft.updated_at)}`,
    `Players: ${lockinPlayers.map(row => `<@${row.discord_user_id}>`).join(', ') || '—'}`,
    `Notes: ${lockinDraft.notes || '—'}`,
    'Draft only: this does not affect official stats until finalize.',
  ].join('\n');
}

async function mirrorToAnnouncementChannel(interaction, config, embed) {
  if (!config?.announce_channel_id || config.announce_channel_id === interaction.channelId) {
    return;
  }

  const channel = interaction.guild.channels.cache.get(config.announce_channel_id);
  if (channel) {
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
  }
}

async function handleManualCorrect(interaction) {
  const eventId = interaction.options.getString('event_id');
  const reason = interaction.options.getString('reason');
  const confirm = interaction.options.getString('confirm');

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)) {
    return interaction.editReply('❌ `event_id` must be a full UUID from a manual session record.');
  }

  if (confirm !== 'VOID') {
    return interaction.editReply('❌ Correction cancelled. Type `VOID` exactly in the confirm field to void a manual session.');
  }

  try {
    const result = await voidManualSession({
      requestId: interaction.id,
      guildId: interaction.guildId,
      eventId,
      actorDiscordId: interaction.user.id,
      reason,
    });

    const embed = new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle(result.alreadyVoided ? 'ℹ️ Session Already Voided' : '🛠️ Session Voided')
      .addFields(
        { name: 'Session ID', value: `\`${eventId}\`` },
        { name: 'Reason', value: reason },
      )
      .setFooter({ text: `Correction request ${interaction.id.slice(0, 8)} · GuildRank` })
      .setTimestamp();

    if (!result.alreadyVoided) {
      embed.addFields({
        name: 'Affected Players',
        value: result.before.participant_ids?.map(id => `<@${id}>`).join(', ') || '—',
      });
    }

    if (!result.statsRebuilt) {
      embed.addFields({
        name: '⚠️ Stats Rebuild',
        value: 'The correction was saved, but the stat refresh failed. A repair has been queued.',
      });
    }

    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    logger.info('manual_session_corrected', {
      request_id: interaction.id,
      guild_id: interaction.guildId,
      actor_id: interaction.user.id,
      event_id: eventId,
      already_voided: result.alreadyVoided,
      stats_rebuilt: result.statsRebuilt,
    });
  } catch (error) {
    logger.error('manual_session_correction_failed', {
      request_id: interaction.id,
      guild_id: interaction.guildId,
      actor_id: interaction.user.id,
      error,
    });
    await interaction.editReply(`❌ Failed to apply that correction. ${error.message || 'Check the event ID and try again.'}`);
  }
}

async function handleManualLog(interaction, subcommand) {
  const game = interaction.options.getString('game');
  const playerMentions = interaction.options.getString('players');
  const attendeeIds = extractMentionedUserIds(playerMentions);
  const config = await getGuildConfig(interaction.guildId);

  if (!attendeeIds.length) {
    return interaction.editReply('❌ No valid @mentions found. Tag the players who attended.');
  }

  if (attendeeIds.length > 50) {
    return interaction.editReply('❌ Too many players in one command. Split large sessions into batches of 50 or fewer.');
  }

  try {
    if (subcommand === 'log') {
      const winner = interaction.options.getUser('winner');
      const mvp = interaction.options.getUser('mvp');
      const notes = interaction.options.getString('notes') || '';

      const result = await recordManualSession({
        requestId: interaction.id,
        guild: interaction.guild,
        gameType: game,
        sessionType: 'competitive',
        attendeeIds,
        winnerId: winner?.id || null,
        mvpId: mvp?.id || null,
        notes,
        loggedBy: interaction.user.id,
      });

      const embed = new EmbedBuilder()
        .setColor(BRAND_COLOR)
        .setTitle(`✅ Competitive Session Logged — ${game}`)
        .setDescription(result.participantIds.map(id => `<@${id}>`).join(', '))
        .addFields(
          { name: '👥 Participants', value: `${result.participantIds.length}`, inline: true },
          { name: '🏆 Winner', value: result.winnerId ? `<@${result.winnerId}>` : '—', inline: true },
          { name: '⭐ MVP', value: result.mvpId ? `<@${result.mvpId}>` : '—', inline: true },
          { name: '📝 Notes', value: notes || '—' },
        )
        .setFooter({ text: `Session #${result.event.id.slice(0, 8)} · GuildRank` })
        .setTimestamp();

      if (result.autoIncludedIds.length) {
        embed.addFields({
          name: 'ℹ️ Auto-added',
          value: result.autoIncludedIds.map(id => `<@${id}>`).join(', '),
        });
      }

      if (result.duplicate) {
        embed.addFields({
          name: 'ℹ️ Duplicate Request',
          value: 'This interaction was already recorded earlier. No extra stats were added.',
        });
      }

      if (!result.statsRebuilt) {
        embed.addFields({
          name: '⚠️ Stats Rebuild',
          value: 'The source session was saved, but the stat refresh failed. A repair has been queued.',
        });
      }

      await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
      await mirrorToAnnouncementChannel(interaction, config, embed);
      logger.info('manual_session_logged', {
        request_id: interaction.id,
        guild_id: interaction.guildId,
        actor_id: interaction.user.id,
        event_id: result.event.id,
        session_type: 'competitive',
        participant_count: result.participantIds.length,
        duplicate: result.duplicate,
        stats_rebuilt: result.statsRebuilt,
      });
      return;
    }

    const result = await recordManualSession({
      requestId: interaction.id,
      guild: interaction.guild,
      gameType: game,
      sessionType: 'casual',
      attendeeIds,
      loggedBy: interaction.user.id,
    });

    const embed = new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle(`📋 Attendance Logged — ${game}`)
      .setDescription(result.participantIds.map(id => `<@${id}>`).join(', '))
      .addFields({ name: '👥 Players Marked Present', value: `${result.participantIds.length}` })
      .setFooter({ text: `Session #${result.event.id.slice(0, 8)} · GuildRank` })
      .setTimestamp();

    if (result.duplicate) {
      embed.addFields({
        name: 'ℹ️ Duplicate Request',
        value: 'This interaction was already recorded earlier. No extra stats were added.',
      });
    }

    if (!result.statsRebuilt) {
      embed.addFields({
        name: '⚠️ Stats Rebuild',
        value: 'The source attendance log was saved, but the stat refresh failed. A repair has been queued.',
      });
    }

    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    await mirrorToAnnouncementChannel(interaction, config, embed);
    logger.info('manual_session_logged', {
      request_id: interaction.id,
      guild_id: interaction.guildId,
      actor_id: interaction.user.id,
      event_id: result.event.id,
      session_type: 'casual',
      participant_count: result.participantIds.length,
      duplicate: result.duplicate,
      stats_rebuilt: result.statsRebuilt,
    });
  } catch (error) {
    logger.error('manual_session_failed', {
      request_id: interaction.id,
      guild_id: interaction.guildId,
      actor_id: interaction.user.id,
      command: subcommand,
      error,
    });
    await interaction.editReply(`❌ Failed to log that session. ${error.message || 'Check the bot permissions and database schema, then try again.'}`);
  }
}

async function handleCandidatesList(interaction) {
  const status = interaction.options.getString('status') || 'all_active';
  const channel = interaction.options.getChannel('channel');
  const limit = interaction.options.getInteger('limit') ?? 10;
  const statuses = status === 'all_active' ? ['open', 'closed'] : [status];

  const candidates = await listSessionCandidates(interaction.guildId, {
    statuses,
    channelId: channel?.id || null,
    limit,
  });

  if (!candidates.length) {
    return interaction.editReply('ℹ️ No matching detected sessions found for this server.');
  }

  const scheduledSessions = await getScheduledSessionsByIds(
    interaction.guildId,
    candidates.map(candidate => candidate.scheduled_session_id)
  );
  const scheduledSessionMap = new Map(scheduledSessions.map(session => [session.id, session]));

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('🧭 Detected Sessions')
    .setDescription(candidates.map(candidate => (
      buildCandidateSummaryLine(candidate, scheduledSessionMap.get(candidate.scheduled_session_id) || null)
    )).join('\n\n'))
    .setFooter({ text: `${candidates.length} detected session${candidates.length === 1 ? '' : 's'}` })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleCandidateDetail(interaction) {
  const candidateId = getRenamedStringOption(interaction, 'session', ['detected_session', 'candidate', 'candidate_id'], true);
  const candidate = await getSessionCandidateById(interaction.guildId, candidateId);
  if (!candidate) {
    return interaction.editReply('❌ Detected session not found in this server.');
  }

  const participants = await listCandidateParticipants(candidate.id, interaction.guildId);
  const scheduledSession = candidate.scheduled_session_id
    ? await getScheduledSessionById(interaction.guildId, candidate.scheduled_session_id)
    : null;
  const lockin = await getLockinDraftWithPlayers(interaction.guildId, candidate.id);
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`🔍 ${buildCandidateDisplayLabel(candidate)}`)
    .setDescription(buildCandidateSummaryLine(candidate, scheduledSession))
    .addFields(
      {
        name: 'Participants',
        value: truncate(buildCandidateParticipantLines(participants).join('\n')),
      },
      {
        name: 'Threshold Snapshot',
        value: `Detected members: ${candidate.detected_member_count}\nStarted: ${formatDateTime(candidate.started_at)}\nEnded: ${candidate.ended_at ? formatDateTime(candidate.ended_at) : 'live'}`,
      },
      {
        name: 'Schedule Context',
        value: truncate(formatCandidateScheduleContext(candidate, scheduledSession)),
      },
    )
    .setTimestamp();

  if (lockin.draft) {
    embed.addFields({
      name: 'Locked Roster',
      value: truncate(formatLockedRoster(lockin.draft, lockin.players)),
    });
  }

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleSessionLockin(interaction) {
  const candidateId = getRenamedStringOption(interaction, 'detected_session', ['candidate', 'candidate_id'], true);
  const candidate = await getSessionCandidateById(interaction.guildId, candidateId);
  const participantMentions = interaction.options.getString('players');
  const participantIds = participantMentions
    ? await resolveMentionedGuildUserIds(interaction, participantMentions, { fieldName: 'players' })
    : null;

  const result = await upsertSessionLockinDraft({
    guildId: interaction.guildId,
    candidateId,
    actorDiscordId: interaction.user.id,
    participantIds,
    notes: interaction.options.getString('notes'),
    requestId: interaction.id,
  });

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('🧷 Session Lock-In Saved')
    .addFields(
      { name: 'Detected Session', value: candidate ? buildCandidateDisplayLabel(candidate) : 'Selected detected session' },
      { name: 'Draft', value: `\`${result.draft.id}\`` },
      { name: 'Selection Source', value: `\`${formatLockinSelectionSource(result.draft.selection_source)}\``, inline: true },
      { name: 'Players', value: truncate(result.players.map(row => `<@${row.discord_user_id}>`).join(', ') || '—') },
    )
    .setFooter({ text: 'Draft only: finalize is still required for official stats' })
    .setTimestamp();

  if (result.draft.scheduled_session_id) {
    embed.addFields({
      name: 'Schedule Context',
      value: `\`${result.draft.scheduled_session_id}\``,
      inline: true,
    });
  }

  if (result.draft.notes) {
    embed.addFields({
      name: 'Notes',
      value: result.draft.notes,
    });
  }

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleLiveSessionStart(interaction) {
  const candidateId = getRenamedStringOption(interaction, 'detected_session', ['candidate', 'candidate_id']);
  const scheduledSessionId = getRenamedStringOption(interaction, 'planned_session', ['scheduled_session', 'scheduled_session_id']);
  const channel = interaction.options.getChannel('channel');
  let result;

  try {
    result = await startLiveSession({
      guild: interaction.guild,
      guildId: interaction.guildId,
      candidateId: candidateId || null,
      scheduledSessionId: scheduledSessionId || null,
      channelId: channel?.id || null,
      gameKey: interaction.options.getString('game'),
      sessionType: interaction.options.getString('session_type'),
      notes: interaction.options.getString('notes'),
      actorDiscordId: interaction.user.id,
      requestId: interaction.id,
    });
  } catch (error) {
    logger.error('session_start_failed_before_persistence', {
      request_id: interaction.id,
      guild_id: interaction.guildId,
      actor_id: interaction.user.id,
      detected_session_id: candidateId || null,
      planned_session_id: scheduledSessionId || null,
      channel_id: channel?.id || null,
      error,
    });
    return interaction.editReply(getLiveSessionStartFailureMessage(error));
  }

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('🟢 Live Session Started')
    .setDescription(buildLiveSessionSummaryLine(result.liveSession, result.people))
    .addFields(
      ...buildLiveSessionStartSourceFields(result),
      { name: 'Players', value: truncate(formatLiveSessionPeople(result.people, 'player')) },
      { name: 'Spectators', value: truncate(formatLiveSessionPeople(result.people, 'spectator')) },
    )
    .setFooter({ text: 'Draft only: official stats move only on finalize' })
    .setTimestamp();

  if (result.liveSession.notes) {
    embed.addFields({ name: 'Notes', value: result.liveSession.notes });
  }

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleLiveSessionUpdate(interaction) {
  const liveSessionId = getRenamedStringOption(interaction, 'live_session', 'live_session_id', true);
  const playerMentions = interaction.options.getString('players');
  const spectatorMentions = interaction.options.getString('spectators');
  const winnerMention = interaction.options.getString('winner');
  const mvpMention = interaction.options.getString('mvp');
  const result = await updateLiveSession({
    guildId: interaction.guildId,
    liveSessionId,
    actorDiscordId: interaction.user.id,
    gameKey: interaction.options.getString('game') ?? undefined,
    playerIds: playerMentions
      ? await resolveMentionedGuildUserIds(interaction, playerMentions, { fieldName: 'players' })
      : undefined,
    spectatorIds: spectatorMentions
      ? await resolveMentionedGuildUserIds(interaction, spectatorMentions, { fieldName: 'spectators' })
      : undefined,
    winnerId: winnerMention
      ? (await resolveMentionedGuildUserIds(interaction, winnerMention, { fieldName: 'winner', requireSingle: true }))[0]
      : undefined,
    mvpId: mvpMention
      ? (await resolveMentionedGuildUserIds(interaction, mvpMention, { fieldName: 'mvp', requireSingle: true }))[0]
      : undefined,
    notes: interaction.options.getString('notes') ?? undefined,
    requestId: interaction.id,
  });

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(result.liveSession.status === 'ended' ? '📝 Ended Live Session Updated' : '📝 Live Session Updated')
    .setDescription(buildLiveSessionSummaryLine(result.liveSession, result.people))
    .addFields(
      { name: 'Players', value: truncate(formatLiveSessionPeople(result.people, 'player')) },
      { name: 'Spectators', value: truncate(formatLiveSessionPeople(result.people, 'spectator')) },
    )
    .setFooter({ text: 'Draft only: official stats move only on finalize' })
    .setTimestamp();

  if (result.liveSession.notes) {
    embed.addFields({ name: 'Notes', value: result.liveSession.notes });
  }

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleLiveSessionEnd(interaction) {
  const liveSessionId = getRenamedStringOption(interaction, 'live_session', 'live_session_id', true);
  const result = await endLiveSession({
    guildId: interaction.guildId,
    liveSessionId,
    actorDiscordId: interaction.user.id,
    notes: interaction.options.getString('notes') ?? undefined,
    requestId: interaction.id,
  });

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('⏹️ Live Session Ended')
    .setDescription(buildLiveSessionSummaryLine(result.liveSession, result.people))
    .addFields(
      { name: 'Players', value: truncate(formatLiveSessionPeople(result.people, 'player')) },
      { name: 'Spectators', value: truncate(formatLiveSessionPeople(result.people, 'spectator')) },
      { name: 'Duration', value: formatDurationMinutes(result.liveSession.started_at, result.liveSession.ended_at), inline: true },
    )
    .setFooter({ text: 'Ready for finalize when the result draft looks correct' })
    .setTimestamp();

  if (result.liveSession.notes) {
    embed.addFields({ name: 'Notes', value: result.liveSession.notes });
  }

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleLiveSessionCheckinOpen(interaction) {
  const liveSessionId = getRenamedStringOption(interaction, 'live_session', 'live_session_id', true);
  if (!interaction.channel?.isTextBased?.()) {
    return interaction.editReply('❌ Check-in prompt can only be posted in a text-based channel.');
  }

  const result = await setLiveSessionCheckinStatus({
    guildId: interaction.guildId,
    liveSessionId,
    actorDiscordId: interaction.user.id,
    status: 'open',
    requestId: interaction.id,
  });

  const prompt = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('GuildRank Session Check-In')
    .setDescription('Are you playing in this session, spectating, or not part of it? Your response helps the operator build the draft roster. It does not finalize stats by itself.')
    .addFields(
      { name: 'Live Session', value: buildLiveSessionDisplayLabel(result.liveSession) },
      { name: 'Channel', value: `<#${result.liveSession.channel_id}>`, inline: true },
      { name: 'Game', value: `\`${result.liveSession.game_key}\``, inline: true },
    )
    .setFooter({ text: 'Draft only: official stats move only on finalize' })
    .setTimestamp();

  await interaction.channel.send({
    embeds: [prompt],
    components: [buildCheckinButtons(liveSessionId)],
    allowedMentions: { parse: [] },
  });

  return interaction.editReply('✅ Check-in is open. I posted the player check-in prompt in this channel.');
}

async function handleLiveSessionCheckinClose(interaction) {
  const liveSessionId = getRenamedStringOption(interaction, 'live_session', 'live_session_id', true);
  const result = await setLiveSessionCheckinStatus({
    guildId: interaction.guildId,
    liveSessionId,
    actorDiscordId: interaction.user.id,
    status: 'closed',
    requestId: interaction.id,
  });

  return interaction.editReply(`✅ Check-in is closed for ${buildLiveSessionDisplayLabel(result.liveSession)}.`);
}

async function handleLiveSessionCheckinSummary(interaction) {
  const liveSessionId = getRenamedStringOption(interaction, 'live_session', 'live_session_id', true);
  const result = await getLiveSessionWithPeople(interaction.guildId, liveSessionId);
  if (!result.liveSession) {
    return interaction.editReply('❌ Live session not found in this server.');
  }
  if (result.liveSession.status !== 'live') {
    return interaction.editReply('❌ Check-in summary is only available while the live session is running in this slice.');
  }

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('🧾 Live Session Check-In Summary')
    .setDescription(buildLiveSessionSummaryLine(result.liveSession, result.people))
    .addFields(await buildCheckinSummaryFields(interaction.guildId, result.liveSession, result.people))
    .setFooter({ text: 'Draft only: operator review and finalize are still required for official stats' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleSessionFinalize(interaction) {
  const candidateId = getRenamedStringOption(interaction, 'detected_session', ['candidate', 'candidate_id']);
  const liveSessionId = getRenamedStringOption(interaction, 'live_session', 'live_session_id');
  if (Boolean(candidateId) === Boolean(liveSessionId)) {
    return interaction.editReply('❌ Choose exactly one finalize source: either `detected_session` or `live_session`.');
  }

  const sourceType = candidateId ? 'detected_session' : 'live_session';
  const sourceId = candidateId || liveSessionId;

  try {
    const scheduledSessionId = getRenamedStringOption(interaction, 'scheduled_session', 'scheduled_session_id') || null;
    const notesInput = interaction.options.getString('notes');
    const participantMentions = interaction.options.getString('players');
    const winnerMention = interaction.options.getString('winner');
    const mvpMention = interaction.options.getString('mvp');
    const participantIds = participantMentions
      ? await resolveMentionedGuildUserIds(interaction, participantMentions, { fieldName: 'players' })
      : null;
    const winnerId = winnerMention
      ? (await resolveMentionedGuildUserIds(interaction, winnerMention, { fieldName: 'winner', requireSingle: true }))[0]
      : null;
    const mvpId = mvpMention
      ? (await resolveMentionedGuildUserIds(interaction, mvpMention, { fieldName: 'mvp', requireSingle: true }))[0]
      : null;

    if (candidateId) {
      const result = await finalizeSessionCandidate({
        requestId: interaction.id,
        guildId: interaction.guildId,
        candidateId,
        actorDiscordId: interaction.user.id,
        scheduledSessionId,
        participantIds,
        notes: notesInput || null,
        winnerId,
        mvpId,
      });
      logger.info('session_finalize_official_created', {
        request_id: interaction.id,
        guild_id: interaction.guildId,
        actor_id: interaction.user.id,
        command: 'session finalize',
        source_type: sourceType,
        participant_count: result.officialEvent.participant_ids?.length || 0,
        duplicate: result.duplicate === true,
        reward_assignment_pending: true,
      });
      const rewardSummary = await assignFinalizeRewardRolesOrWarn(interaction, {
        participantIds: result.officialEvent.participant_ids || [],
        source: 'candidate_finalize',
        sourceType,
      });

      const embed = new EmbedBuilder()
        .setColor(BRAND_COLOR)
        .setTitle('✅ Detected Session Finalized')
        .addFields(
          { name: 'Detected Session', value: result.candidate ? buildCandidateDisplayLabel(result.candidate) : 'Selected detected session' },
          { name: 'Official Session', value: `\`${result.officialEvent.id}\`` },
          { name: 'Game', value: result.officialEvent.game_type || '—', inline: true },
          { name: 'Type', value: result.officialEvent.session_type || '—', inline: true },
          { name: 'Participants', value: `${result.officialEvent.participant_ids?.length || 0}`, inline: true },
          { name: 'Roster Source', value: `\`${formatLockinSelectionSource(result.participantSource)}\``, inline: true },
          { name: 'Roster', value: truncate((result.officialEvent.participant_ids || []).map(id => `<@${id}>`).join(', ') || '—') },
          { name: 'Participant Reward Role', value: truncate(formatRewardSummary(rewardSummary)) },
        )
        .setFooter({ text: result.statsRebuilt ? 'Stats rebuilt successfully' : 'Stats repair queued' })
        .setTimestamp();

      if (result.officialEvent.scheduled_session_id) {
        embed.addFields({
          name: 'Scheduled Session',
          value: `\`${result.officialEvent.scheduled_session_id}\``,
        });
      }

      if (result.duplicate) {
        embed.addFields({
          name: 'ℹ️ Duplicate Request',
          value: 'This finalize request was already applied earlier. No extra official session was created.',
        });
      }

      return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    const result = await finalizeLiveSession({
      requestId: interaction.id,
      guildId: interaction.guildId,
      liveSessionId,
      actorDiscordId: interaction.user.id,
      participantIds,
      scheduledSessionId,
      notes: notesInput ?? undefined,
      winnerId: winnerId ?? undefined,
      mvpId: mvpId ?? undefined,
    });
    logger.info('session_finalize_official_created', {
      request_id: interaction.id,
      guild_id: interaction.guildId,
      actor_id: interaction.user.id,
      command: 'session finalize',
      source_type: sourceType,
      participant_count: result.officialEvent.participant_ids?.length || 0,
      duplicate: result.duplicate === true,
      reward_assignment_pending: true,
    });
    const rewardSummary = await assignFinalizeRewardRolesOrWarn(interaction, {
      participantIds: result.officialEvent.participant_ids || [],
      people: result.people || [],
      source: 'live_session_finalize',
      sourceType,
    });

    const embed = new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle('✅ Live Session Finalized')
      .addFields(
        { name: 'Live Session', value: buildLiveSessionDisplayLabel(result.liveSession) },
        { name: 'Official Session', value: `\`${result.officialEvent.id}\`` },
        { name: 'Game', value: result.officialEvent.game_type || '—', inline: true },
        { name: 'Type', value: result.officialEvent.session_type || '—', inline: true },
        { name: 'Participants', value: `${result.officialEvent.participant_ids?.length || 0}`, inline: true },
        { name: 'Roster Source', value: `\`${formatLockinSelectionSource(result.participantSource)}\``, inline: true },
        { name: 'Roster', value: truncate((result.officialEvent.participant_ids || []).map(id => `<@${id}>`).join(', ') || '—') },
        { name: 'Participant Reward Role', value: truncate(formatRewardSummary(rewardSummary)) },
      )
      .setFooter({ text: result.statsRebuilt ? 'Stats rebuilt successfully' : 'Stats repair queued' })
      .setTimestamp();

    if (result.officialEvent.scheduled_session_id) {
      embed.addFields({
        name: 'Scheduled Session',
        value: `\`${result.officialEvent.scheduled_session_id}\``,
      });
    }

    if (result.liveSession.source_candidate_id) {
      embed.addFields({
        name: 'Consumed Detected Session',
        value: 'The linked detected session was marked finalized through this live session.',
      });
    }

    if (result.duplicate) {
      embed.addFields({
        name: 'ℹ️ Duplicate Request',
        value: 'This finalize request was already applied earlier. No extra official session was created.',
      });
    }

    return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    await logFinalizeFailure(interaction, { sourceType, sourceId, error });
    return interaction.editReply({
      content: formatFinalizeFailureMessage(error, sourceType),
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
  }
}

async function handleSessionSchedule(interaction) {
  const channel = interaction.options.getChannel('voice_channel');
  const host = interaction.options.getUser('host');
  const scheduledSession = await createScheduledSession({
    guildId: interaction.guildId,
    gameKey: interaction.options.getString('game', true),
    sessionType: interaction.options.getString('session_type', true),
    startTimeInput: interaction.options.getString('start_time', true),
    timezoneLabel: interaction.options.getString('timezone'),
    linkedChannelId: channel?.id || null,
    hostDiscordUserId: host?.id || null,
    notes: interaction.options.getString('notes'),
    actorDiscordId: interaction.user.id,
    requestId: interaction.id,
  });

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('🗓️ Session Scheduled')
    .setDescription(buildScheduleSummaryLine(scheduledSession))
    .addFields({
      name: 'Reminder',
      value: 'Schedules do not affect official stats by themselves. They become official only if later linked during finalize.',
    })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleSessionUpcoming(interaction) {
  const limit = interaction.options.getInteger('limit') ?? 10;
  const sessions = await listUpcomingScheduledSessions(interaction.guildId, { limit });

  if (!sessions.length) {
    return interaction.editReply('ℹ️ No scheduled sessions are currently queued for this server.');
  }

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('🗓️ Upcoming Sessions')
    .setDescription(sessions.map(buildScheduleSummaryLine).join('\n\n'))
    .setFooter({ text: `${sessions.length} scheduled session${sessions.length === 1 ? '' : 's'}` })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleSessionCancel(interaction) {
  const scheduledSessionId = getRenamedStringOption(interaction, 'scheduled_session', 'scheduled_session_id', true);
  const reason = interaction.options.getString('reason');
  const session = await cancelScheduledSession({
    guildId: interaction.guildId,
    scheduledSessionId,
    actorDiscordId: interaction.user.id,
    reason,
    requestId: interaction.id,
  });

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('🛑 Scheduled Session Cancelled')
    .setDescription(buildScheduleSummaryLine(session))
    .addFields({ name: 'Reason', value: reason || '—' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleSessionReschedule(interaction) {
  const channel = interaction.options.getChannel('voice_channel');
  const host = interaction.options.getUser('host');
  const session = await rescheduleScheduledSession({
    guildId: interaction.guildId,
    scheduledSessionId: getRenamedStringOption(interaction, 'scheduled_session', 'scheduled_session_id', true),
    actorDiscordId: interaction.user.id,
    startTimeInput: interaction.options.getString('start_time', true),
    timezoneLabel: interaction.options.getString('timezone') ?? undefined,
    linkedChannelId: interaction.options.getChannel('voice_channel') ? (channel?.id || null) : undefined,
    hostDiscordUserId: interaction.options.getUser('host') ? (host?.id || null) : undefined,
    notes: interaction.options.getString('notes') ?? undefined,
    gameKey: interaction.options.getString('game') ?? undefined,
    sessionType: interaction.options.getString('session_type') ?? undefined,
    requestId: interaction.id,
  });

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('🔁 Scheduled Session Rescheduled')
    .setDescription(buildScheduleSummaryLine(session))
    .setTimestamp();

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleCandidateDiscard(interaction) {
  const candidateId = getRenamedStringOption(interaction, 'detected_session', ['candidate', 'candidate_id'], true);
  const reason = interaction.options.getString('reason', true);

  const result = await discardSessionCandidate({
    guildId: interaction.guildId,
    candidateId,
    actorDiscordId: interaction.user.id,
    reason,
    requestId: interaction.id,
  });

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(result.alreadyDiscarded ? 'ℹ️ Detected Session Already Discarded' : '🗑️ Detected Session Discarded')
    .addFields(
      { name: 'Detected Session', value: result.candidate ? buildCandidateDisplayLabel(result.candidate) : 'Selected detected session' },
      { name: 'Reason', value: reason },
      { name: 'Status', value: `\`${result.candidate?.status || 'discarded'}\`` },
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleCheckinButton(interaction) {
  const parsed = parseCheckinCustomId(interaction.customId);
  if (!parsed) return false;

  await interaction.deferReply({ ephemeral: true });

  if (!interaction.guildId || !interaction.guild) {
    await interaction.editReply('❌ Check-in only works inside a server.');
    return true;
  }

  const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || interaction.user.bot) {
    await interaction.editReply('❌ Only server members can check in for a live session.');
    return true;
  }

  try {
    await recordLiveSessionConfirmation({
      guildId: interaction.guildId,
      liveSessionId: parsed.liveSessionId,
      discordUserId: interaction.user.id,
      response: parsed.response,
      source: 'button',
      requestId: interaction.id,
    });

    const responseLabel = {
      playing: 'playing',
      spectating: 'spectating',
      not_in_session: 'not in this session',
    }[parsed.response];

    await interaction.editReply(`✅ Your GuildRank check-in was saved as **${responseLabel}**. This is draft roster info only; official stats move only after an operator finalizes the session.`);
  } catch (error) {
    logger.error('session_checkin_button_failed', {
      request_id: interaction.id,
      guild_id: interaction.guildId,
      actor_id: interaction.user?.id,
      live_session_id: parsed.liveSessionId,
      response: parsed.response,
      error,
    });
    await interaction.editReply(`❌ Check-in was not saved. ${error.message || 'Ask an operator to review the live session.'}`);
  }

  return true;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('session')
    .setDescription('Log a games night session and manage VC-assisted detected sessions')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
    .addSubcommand(subcommand =>
      subcommand
        .setName('log')
        .setDescription('Log a competitive session and credit all participants')
        .addStringOption(option => option.setName('game').setDescription('Game name').setRequired(true).setMaxLength(80))
        .addStringOption(option => option.setName('players').setDescription('Mention everyone who played e.g. @Nala @ZK').setRequired(true).setMaxLength(500))
        .addUserOption(option => option.setName('winner').setDescription('Winner').setRequired(false))
        .addUserOption(option => option.setName('mvp').setDescription('MVP').setRequired(false))
        .addStringOption(option => option.setName('notes').setDescription('Any notes').setRequired(false).setMaxLength(300))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('attendance')
        .setDescription('Mark who attended a casual session')
        .addStringOption(option => option.setName('game').setDescription('Game played').setRequired(true).setMaxLength(80))
        .addStringOption(option => option.setName('players').setDescription('Mention everyone who attended').setRequired(true).setMaxLength(500))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('correct')
        .setDescription('Void a manual session log and rebuild the guild stats')
        .addStringOption(option => option.setName('event_id').setDescription('Full manual session event ID').setRequired(true).setMaxLength(36))
        .addStringOption(option => option.setName('reason').setDescription('Why this correction is needed').setRequired(true).setMaxLength(300))
        .addStringOption(option => option.setName('confirm').setDescription('Type VOID to confirm').setRequired(true).setMaxLength(4))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('start')
        .setDescription('Start a live draft from detected voice activity, a planned session, or a tracked VC')
        .addStringOption(option =>
          option
            .setName('detected_session')
            .setDescription('Start from a session GuildRank already detected from voice activity')
            .setRequired(false)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
        .addStringOption(option =>
          option
            .setName('planned_session')
            .setDescription('Start from a session that was scheduled ahead of time')
            .setRequired(false)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Start directly from a tracked voice channel')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false)
        )
        .addStringOption(option => option.setName('game').setDescription('Optional game label for this live session').setRequired(false).setMaxLength(80))
        .addStringOption(option =>
          option
            .setName('session_type')
            .setDescription('Optional session type for this live session')
            .setRequired(false)
            .addChoices(
              { name: 'Competitive', value: 'competitive' },
              { name: 'Casual', value: 'casual' },
            )
        )
        .addStringOption(option => option.setName('notes').setDescription('Optional notes for this live session').setRequired(false).setMaxLength(300))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('update')
        .setDescription('Update the draft game label, roster, result, or notes for a live session')
        .addStringOption(option =>
          option
            .setName('live_session')
            .setDescription('Select a recent live or ended session')
            .setRequired(true)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
        .addStringOption(option => option.setName('players').setDescription('Optional player roster replacement using mentions').setRequired(false).setMaxLength(500))
        .addStringOption(option => option.setName('spectators').setDescription('Optional spectator roster replacement using mentions').setRequired(false).setMaxLength(500))
        .addStringOption(option => option.setName('game').setDescription('Optional corrected game label for this live session').setRequired(false).setMaxLength(80))
        .addStringOption(option => option.setName('winner').setDescription('Optional winner mention, e.g. @Nala').setRequired(false).setMaxLength(100))
        .addStringOption(option => option.setName('mvp').setDescription('Optional MVP mention, e.g. @Nala').setRequired(false).setMaxLength(100))
        .addStringOption(option => option.setName('notes').setDescription('Optional updated live notes').setRequired(false).setMaxLength(300))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('end')
        .setDescription('Mark a live session as ended without moving official stats yet')
        .addStringOption(option =>
          option
            .setName('live_session')
            .setDescription('Select a recent live session')
            .setRequired(true)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
        .addStringOption(option => option.setName('notes').setDescription('Optional closing notes').setRequired(false).setMaxLength(300))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('checkin_open')
        .setDescription('Open player self-confirmation for a running live session')
        .addStringOption(option =>
          option
            .setName('live_session')
            .setDescription('Select a running live session')
            .setRequired(true)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('checkin_close')
        .setDescription('Close player self-confirmation for a running live session')
        .addStringOption(option =>
          option
            .setName('live_session')
            .setDescription('Select a running live session')
            .setRequired(true)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('checkin_summary')
        .setDescription('Review player self-confirmation responses for a live session')
        .addStringOption(option =>
          option
            .setName('live_session')
            .setDescription('Select a running live session')
            .setRequired(true)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('schedule')
        .setDescription('Schedule a future session without affecting stats yet')
        .addStringOption(option => option.setName('game').setDescription('Default game label').setRequired(true).setMaxLength(80))
        .addStringOption(option =>
          option
            .setName('session_type')
            .setDescription('Planned session type')
            .setRequired(true)
            .addChoices(
              { name: 'Competitive', value: 'competitive' },
              { name: 'Casual', value: 'casual' },
            )
        )
        .addStringOption(option => option.setName('start_time').setDescription('ISO datetime with UTC or offset, e.g. 2026-05-01T17:00:00Z').setRequired(true).setMaxLength(40))
        .addStringOption(option => option.setName('timezone').setDescription('Optional timezone label for display, e.g. UTC or Africa/Lagos').setRequired(false).setMaxLength(80))
        .addChannelOption(option =>
          option
            .setName('voice_channel')
            .setDescription('Optional linked voice channel')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false)
        )
        .addUserOption(option => option.setName('host').setDescription('Optional host or operator').setRequired(false))
        .addStringOption(option => option.setName('notes').setDescription('Optional planning notes').setRequired(false).setMaxLength(300))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('upcoming')
        .setDescription('List upcoming scheduled sessions for this server')
        .addIntegerOption(option => option.setName('limit').setDescription('Number of scheduled sessions to return').setRequired(false).setMinValue(1).setMaxValue(25))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('cancel')
        .setDescription('Cancel a scheduled session')
        .addStringOption(option => option.setName('scheduled_session').setDescription('Scheduled session to cancel').setRequired(true).setMaxLength(36))
        .addStringOption(option => option.setName('reason').setDescription('Optional cancellation reason').setRequired(false).setMaxLength(300))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('reschedule')
        .setDescription('Reschedule an existing scheduled session')
        .addStringOption(option => option.setName('scheduled_session').setDescription('Scheduled session to reschedule').setRequired(true).setMaxLength(36))
        .addStringOption(option => option.setName('start_time').setDescription('New ISO datetime with UTC or offset').setRequired(true).setMaxLength(40))
        .addStringOption(option => option.setName('timezone').setDescription('Optional updated timezone label').setRequired(false).setMaxLength(80))
        .addStringOption(option => option.setName('game').setDescription('Optional updated game label').setRequired(false).setMaxLength(80))
        .addStringOption(option =>
          option
            .setName('session_type')
            .setDescription('Optional updated session type')
            .setRequired(false)
            .addChoices(
              { name: 'Competitive', value: 'competitive' },
              { name: 'Casual', value: 'casual' },
            )
        )
        .addChannelOption(option =>
          option
            .setName('voice_channel')
            .setDescription('Optional updated linked voice channel')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false)
        )
        .addUserOption(option => option.setName('host').setDescription('Optional updated host or operator').setRequired(false))
        .addStringOption(option => option.setName('notes').setDescription('Optional updated notes').setRequired(false).setMaxLength(300))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('detected_sessions')
        .setDescription('List detected sessions from private VC activity')
        .addStringOption(option =>
          option
            .setName('status')
            .setDescription('Detected session status filter')
            .setRequired(false)
            .addChoices(...CANDIDATE_STATUS_CHOICES)
        )
        .addChannelOption(option => option.setName('channel').setDescription('Filter to one voice channel').setRequired(false))
        .addIntegerOption(option => option.setName('limit').setDescription('Number of detected sessions to return').setRequired(false).setMinValue(1).setMaxValue(25))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('detected_session')
        .setDescription('Inspect one detected session from private VC activity')
        .addStringOption(option =>
          option
            .setName('session')
            .setDescription('Select a recent detected session')
            .setRequired(true)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('lockin')
        .setDescription('Create or replace a draft player roster for a closed detected session')
        .addStringOption(option =>
          option
            .setName('detected_session')
            .setDescription('Select a recent closed detected session')
            .setRequired(true)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
        .addStringOption(option => option.setName('players').setDescription('Optional roster override using mentions; defaults to threshold-qualified participants').setRequired(false).setMaxLength(500))
        .addStringOption(option => option.setName('notes').setDescription('Optional admin notes for this draft roster').setRequired(false).setMaxLength(300))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('finalize')
        .setDescription('Finalize a closed detected session or ended live session into an official session')
        .addStringOption(option =>
          option
            .setName('detected_session')
            .setDescription('Select a recent closed detected session')
            .setRequired(false)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
        .addStringOption(option =>
          option
            .setName('live_session')
            .setDescription('Select a recent ended live session')
            .setRequired(false)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
        .addStringOption(option =>
          option
            .setName('scheduled_session')
            .setDescription('Optional scheduled session to link during finalize')
            .setRequired(false)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
        .addStringOption(option => option.setName('players').setDescription('Optional participant roster override using mentions').setRequired(false).setMaxLength(500))
        .addStringOption(option => option.setName('winner').setDescription('Optional winner mention, e.g. @Nala').setRequired(false).setMaxLength(100))
        .addStringOption(option => option.setName('mvp').setDescription('Optional MVP mention, e.g. @Nala').setRequired(false).setMaxLength(100))
        .addStringOption(option => option.setName('notes').setDescription('Optional official session notes').setRequired(false).setMaxLength(300))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('discard')
        .setDescription('Discard a detected session from VC activity')
        .addStringOption(option =>
          option
            .setName('detected_session')
            .setDescription('Select a recent detected session')
            .setRequired(true)
            .setMaxLength(36)
            .setAutocomplete(true)
        )
        .addStringOption(option => option.setName('reason').setDescription('Why this detected session should be discarded').setRequired(true).setMaxLength(300))
    ),

  handleButton: handleCheckinButton,

  async autocomplete(interaction) {
    const subcommand = resolveAutocompleteSubcommand(interaction);
    const focused = interaction.options.getFocused(true);

    if (!interaction.guildId) {
      return respondAutocompleteChoices(interaction, [], {
        subcommand,
        focused_option: focused.name,
      });
    }

    const requiredPermission = requiresManageGuild(subcommand)
      ? PermissionFlagsBits.ManageGuild
      : PermissionFlagsBits.ManageEvents;
    if (!hasAutocompletePermission(interaction, requiredPermission)) {
      logger.warn('session_autocomplete_permission_unresolved', {
        request_id: interaction.id,
        guild_id: interaction.guildId,
        actor_id: interaction.user?.id,
        subcommand,
        focused_option: focused.name,
        has_member_permissions: Boolean(interaction.memberPermissions),
        has_member_permissions_fallback: Boolean(interaction.member?.permissions),
      });
      return respondAutocompleteChoices(interaction, [], {
        subcommand,
        focused_option: focused.name,
        reason: 'permission_unresolved',
      });
    }

    const search = String(focused.value || '').trim().toLowerCase();

    if (focused.name === 'session' || focused.name === 'detected_session' || focused.name === 'candidate' || focused.name === 'candidate_id') {
      const statusMap = {
        detected_session: ['open', 'closed', 'finalized', 'discarded'],
        candidate: ['open', 'closed', 'finalized', 'discarded'],
        lockin: ['closed'],
        start: ['closed'],
        finalize: ['closed'],
        discard: ['open', 'closed', 'discarded'],
      };

      const statuses = statusMap[subcommand];
      if (!statuses) {
        logger.warn('session_candidate_autocomplete_unmapped_subcommand', {
          request_id: interaction.id,
          guild_id: interaction.guildId,
          actor_id: interaction.user?.id,
          subcommand,
          focused_option: focused.name,
        });
        return respondAutocompleteChoices(interaction, [], {
          subcommand,
          focused_option: focused.name,
          reason: 'unmapped_candidate_subcommand',
        });
      }

      let recentCandidates = [];
      try {
        recentCandidates = await withAutocompleteTimeout(
          listSessionCandidates(interaction.guildId, {
            statuses,
            limit: search ? 100 : 25,
          }),
          2200,
          'candidate_autocomplete_query_timeout'
        );
      } catch (error) {
        logger.error('session_candidate_autocomplete_query_failed', {
          request_id: interaction.id,
          guild_id: interaction.guildId,
          actor_id: interaction.user?.id,
          subcommand,
          focused_option: focused.name,
          status_filter: statuses,
          search_present: Boolean(search),
          error,
        });
        return respondAutocompleteChoices(interaction, [], {
          subcommand,
          focused_option: focused.name,
          reason: 'candidate_query_failed',
        });
      }

      const filteredCandidates = search
        ? recentCandidates.filter(candidate => buildCandidateSearchText(candidate).includes(search))
        : recentCandidates;

      if (!filteredCandidates.length) {
        logger.warn('session_candidate_autocomplete_empty', {
          request_id: interaction.id,
          guild_id: interaction.guildId,
          actor_id: interaction.user?.id,
          subcommand,
          focused_option: focused.name,
          status_filter: statuses,
          search_present: Boolean(search),
          candidate_count_before_filter: recentCandidates.length,
          candidate_count_after_filter: filteredCandidates.length,
        });
      }

      return respondAutocompleteChoices(
        interaction,
        filteredCandidates.slice(0, 25).map(candidate => ({
          name: buildCandidateAutocompleteName(candidate),
          value: candidate.id,
        })),
        {
          subcommand,
          focused_option: focused.name,
          status_filter: statuses,
        }
      );
    }

    if (focused.name === 'live_session' || focused.name === 'live_session_id') {
      const statusMap = {
        update: ['live', 'ended'],
        end: ['live'],
        checkin_open: ['live'],
        checkin_close: ['live'],
        checkin_summary: ['live'],
        finalize: ['ended'],
      };

      const statuses = statusMap[subcommand];
      if (!statuses) {
        return respondAutocompleteChoices(interaction, [], {
          subcommand,
          focused_option: focused.name,
          reason: 'unmapped_live_session_subcommand',
        });
      }

      const liveSessions = await listLiveSessions(interaction.guildId, {
        statuses,
        limit: 20,
      });

      const filteredLiveSessions = search
        ? liveSessions.filter(session => buildLiveSessionSearchText(session).includes(search))
        : liveSessions;

      return respondAutocompleteChoices(
        interaction,
        filteredLiveSessions.slice(0, 25).map(liveSession => ({
          name: buildLiveSessionAutocompleteName(liveSession),
          value: liveSession.id,
        })),
        {
          subcommand,
          focused_option: focused.name,
        }
      );
    }

    if (focused.name === 'planned_session' || focused.name === 'scheduled_session' || focused.name === 'scheduled_session_id') {
      const scheduledSessions = await listUpcomingScheduledSessions(interaction.guildId, { limit: 20 });
      const filteredSessions = search
        ? scheduledSessions.filter(session => buildScheduleSearchText(session).includes(search))
        : scheduledSessions;

      return respondAutocompleteChoices(
        interaction,
        filteredSessions.slice(0, 25).map(session => ({
          name: buildScheduleAutocompleteName(session, interaction.guild),
          value: session.id,
        })),
        {
          subcommand,
          focused_option: focused.name,
        }
      );
    }

    return respondAutocompleteChoices(interaction, [], {
      subcommand,
      focused_option: focused.name,
      reason: 'unsupported_focused_option',
    });
  },

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const privateReply = requiresPrivateReply(subcommand);
    const requireManageGuild = requiresManageGuild(subcommand);
    const requiredPermission = requireManageGuild ? PermissionFlagsBits.ManageGuild : PermissionFlagsBits.ManageEvents;
    const requiredLabel = requireManageGuild ? 'Manage Server' : 'Manage Events';

    if (!interaction.memberPermissions?.has(requiredPermission)) {
      return interaction.reply({ content: `❌ You need ${requiredLabel} to use this session command.`, ephemeral: true });
    }

    if (privateReply) {
      await interaction.deferReply({ ephemeral: true });
    }

    const throttle = checkMutationThrottle({
      commandKey: `session_${subcommand}`,
      guildId: interaction.guildId,
      actorId: interaction.user.id,
      userWindowMs: ['correct', 'lockin', 'finalize', 'discard'].includes(subcommand) ? 30_000 : 10_000,
      guildWindowMs: ['correct', 'lockin', 'finalize', 'discard'].includes(subcommand) ? 10_000 : 3_000,
    });

    if (!throttle.allowed) {
      logger.info('mutation_throttled', {
        request_id: interaction.id,
        guild_id: interaction.guildId,
        actor_id: interaction.user.id,
        command: `session_${subcommand}`,
        scope: throttle.scope,
        retry_after_seconds: throttle.retryAfterSeconds,
      });
      const content = `⏳ \`/session ${subcommand}\` is cooling down for this ${throttle.scope}. Try again in about ${throttle.retryAfterSeconds}s.`;
      if (privateReply) {
        return interaction.editReply({ content });
      }

      return interaction.reply({ content, ephemeral: true });
    }

    if (!(await isSetup(interaction.guildId))) {
      if (privateReply) {
        return interaction.editReply({ content: '⚙️ Run `/setup` first!' });
      }

      return interaction.reply({ content: '⚙️ Run `/setup` first!', ephemeral: true });
    }

    if (!privateReply) {
      await interaction.deferReply({ ephemeral: false });
    }

    try {
      if (subcommand === 'correct') return handleManualCorrect(interaction);
      if (subcommand === 'log' || subcommand === 'attendance') return handleManualLog(interaction, subcommand);
      if (subcommand === 'schedule') return handleSessionSchedule(interaction);
      if (subcommand === 'upcoming') return handleSessionUpcoming(interaction);
      if (subcommand === 'cancel') return handleSessionCancel(interaction);
      if (subcommand === 'reschedule') return handleSessionReschedule(interaction);
      if (subcommand === 'detected_sessions' || subcommand === 'candidates') return handleCandidatesList(interaction);
      if (subcommand === 'detected_session' || subcommand === 'candidate') return handleCandidateDetail(interaction);
      if (subcommand === 'lockin') return handleSessionLockin(interaction);
      if (subcommand === 'start') return handleLiveSessionStart(interaction);
      if (subcommand === 'update') return handleLiveSessionUpdate(interaction);
      if (subcommand === 'end') return handleLiveSessionEnd(interaction);
      if (subcommand === 'checkin_open') return handleLiveSessionCheckinOpen(interaction);
      if (subcommand === 'checkin_close') return handleLiveSessionCheckinClose(interaction);
      if (subcommand === 'checkin_summary') return handleLiveSessionCheckinSummary(interaction);
      if (subcommand === 'finalize') return handleSessionFinalize(interaction);
      if (subcommand === 'discard') return handleCandidateDiscard(interaction);

      return interaction.editReply('❌ Unsupported session subcommand.');
    } catch (error) {
      logger.error('session_command_failed', {
        request_id: interaction.id,
        guild_id: interaction.guildId,
        actor_id: interaction.user.id,
        command: subcommand,
        error,
      });
      return interaction.editReply(`❌ Session command failed. ${error.message || 'Try again.'}`);
    }
  },
};
