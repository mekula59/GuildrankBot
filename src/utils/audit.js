const supabase = require('./supabase');

async function writeAuditLog({
  guildId,
  actorDiscordId = null,
  actionType,
  targetType,
  targetId = null,
  requestId = null,
  reason = null,
  before = null,
  after = null,
  metadata = {},
}) {
  if (!guildId) throw new Error('guildId is required for audit logging.');
  if (!actionType) throw new Error('actionType is required for audit logging.');
  if (!targetType) throw new Error('targetType is required for audit logging.');

  const { error } = await supabase
    .from('audit_logs')
    .insert({
      guild_id: guildId,
      actor_discord_id: actorDiscordId,
      action_type: actionType,
      target_type: targetType,
      target_id: targetId,
      request_id: requestId,
      reason,
      before_json: before,
      after_json: after,
      metadata,
    });

  if (error) {
    if (error.code === '23505') return;
    throw error;
  }
}

module.exports = { writeAuditLog };
