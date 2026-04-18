const supabase = require('./supabase');

async function recordAdminCorrection({
  requestId = null,
  guildId,
  actorDiscordId,
  correctionType,
  targetType,
  targetId = null,
  reason,
  before = null,
  after = null,
  metadata = {},
}) {
  if (!guildId) throw new Error('guildId is required for admin corrections.');
  if (!actorDiscordId) throw new Error('actorDiscordId is required for admin corrections.');
  if (!correctionType) throw new Error('correctionType is required for admin corrections.');
  if (!targetType) throw new Error('targetType is required for admin corrections.');
  if (!reason || !reason.trim()) throw new Error('reason is required for admin corrections.');

  const { data, error } = await supabase.rpc('record_admin_correction', {
    p_request_id: requestId,
    p_guild_id: guildId,
    p_actor_discord_id: actorDiscordId,
    p_correction_type: correctionType,
    p_target_type: targetType,
    p_target_id: targetId,
    p_reason: reason.trim(),
    p_before_json: before,
    p_after_json: after,
    p_metadata: metadata,
  });

  if (error) throw error;
  return data;
}

module.exports = { recordAdminCorrection };
