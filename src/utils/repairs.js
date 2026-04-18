const supabase = require('./supabase');
const logger = require('./logger');

async function enqueueStatsRepair({
  guildId,
  requestId = null,
  requestedBy = null,
  reason,
  metadata = {},
}) {
  const { error } = await supabase
    .from('pending_repairs')
    .upsert({
      repair_type: 'guild_stats',
      scope_key: guildId,
      guild_id: guildId,
      status: 'pending',
      requested_by: requestedBy,
      request_id: requestId,
      last_error: reason,
      metadata,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'repair_type,scope_key' });

  if (error) throw error;
}

async function completeStatsRepair(guildId) {
  const { error } = await supabase
    .from('pending_repairs')
    .update({
      status: 'completed',
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('repair_type', 'guild_stats')
    .eq('scope_key', guildId);

  if (error) throw error;
}

async function completeAllStatsRepairs() {
  const { error } = await supabase
    .from('pending_repairs')
    .update({
      status: 'completed',
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('repair_type', 'guild_stats')
    .in('status', ['pending', 'failed']);

  if (error) throw error;
}

async function failStatsRepair(guildId, errorMessage) {
  const { data: existing, error: fetchError } = await supabase
    .from('pending_repairs')
    .select('attempts')
    .eq('repair_type', 'guild_stats')
    .eq('scope_key', guildId)
    .maybeSingle();

  if (fetchError) throw fetchError;

  const { error } = await supabase
    .from('pending_repairs')
    .update({
      status: 'failed',
      last_error: errorMessage,
      attempts: (existing?.attempts || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('repair_type', 'guild_stats')
    .eq('scope_key', guildId);

  if (error) throw error;
}

async function getPendingStatsRepairs(limit = 25) {
  const { data, error } = await supabase
    .from('pending_repairs')
    .select('*')
    .eq('repair_type', 'guild_stats')
    .in('status', ['pending', 'failed'])
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function runPendingStatsRepairs(recalculateAllStats) {
  const repairs = await getPendingStatsRepairs();
  if (!repairs.length) return 0;

  let completed = 0;

  for (const repair of repairs) {
    try {
      await recalculateAllStats({
        guildId: repair.guild_id,
        reason: 'pending_repair',
        requestId: repair.request_id,
      });
      await completeStatsRepair(repair.guild_id);
      completed += 1;
    } catch (error) {
      logger.error('pending_stats_repair_failed', {
        guild_id: repair.guild_id,
        request_id: repair.request_id,
        error,
      });
      await failStatsRepair(repair.guild_id, error.message || 'unknown_error');
    }
  }

  return completed;
}

module.exports = {
  enqueueStatsRepair,
  completeStatsRepair,
  completeAllStatsRepairs,
  failStatsRepair,
  getPendingStatsRepairs,
  runPendingStatsRepairs,
};
