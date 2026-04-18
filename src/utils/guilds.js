const supabase = require('./supabase');

// In-memory cache so we're not hitting DB on every event
const cache = new Map();

/**
 * Get a guild's config. Returns null if guild hasn't run /setup yet.
 */
async function getGuildConfig(guildId) {
  if (cache.has(guildId)) return cache.get(guildId);

  const { data } = await supabase
    .from('guild_configs')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (data) cache.set(guildId, data);
  return data || null;
}

/**
 * Save or update a guild's config and refresh cache.
 */
async function saveGuildConfig(guildId, config) {
  const row = { guild_id: guildId, ...config, updated_at: new Date().toISOString() };

  const { data, error } = await supabase
    .from('guild_configs')
    .upsert(row, { onConflict: 'guild_id' })
    .select()
    .single();

  if (error) throw error;
  cache.set(guildId, data);
  return data;
}

/**
 * Check if guild is fully set up.
 */
async function isSetup(guildId) {
  const config = await getGuildConfig(guildId);
  return config?.is_setup === true;
}

/**
 * Get all guild configs (for cron jobs that run across all servers).
 */
async function getAllGuilds() {
  const { data } = await supabase
    .from('guild_configs')
    .select('*')
    .eq('is_setup', true);
  return data || [];
}

function invalidateGuildConfig(guildId) {
  cache.delete(guildId);
}

module.exports = { getGuildConfig, saveGuildConfig, isSetup, getAllGuilds, invalidateGuildConfig };
