const os = require('os');

const VALID_ENVIRONMENTS = ['local', 'development', 'staging', 'production'];

const REQUIRED_ENV = {
  runtime: ['GUILDRANK_ENV', 'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'],
  deployGlobal: ['GUILDRANK_ENV', 'DISCORD_TOKEN', 'DISCORD_CLIENT_ID'],
  deployGuild: ['GUILDRANK_ENV', 'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_DEV_GUILD_ID'],
};

const PLACEHOLDER_PREFIXES = ['your_', 'change_me', 'example', 'placeholder'];

function validateEnvironment(target = 'runtime') {
  const required = REQUIRED_ENV[target];
  if (!required) {
    throw new Error(`Unknown environment validation target "${target}".`);
  }

  const errors = [];

  for (const key of required) {
    const value = process.env[key];
    if (!value || !value.trim()) {
      errors.push(`${key} is required.`);
      continue;
    }

    if (PLACEHOLDER_PREFIXES.some(prefix => value.toLowerCase().startsWith(prefix))) {
      errors.push(`${key} still contains a placeholder value.`);
    }
  }

  if (required.includes('SUPABASE_URL') && process.env.SUPABASE_URL) {
    try {
      const url = new URL(process.env.SUPABASE_URL);
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.push('SUPABASE_URL must be a valid http(s) URL.');
      }
    } catch {
      errors.push('SUPABASE_URL must be a valid URL.');
    }
  }

  if (required.includes('DISCORD_DEV_GUILD_ID') && process.env.DISCORD_DEV_GUILD_ID) {
    if (!/^\d{17,20}$/.test(process.env.DISCORD_DEV_GUILD_ID)) {
      errors.push('DISCORD_DEV_GUILD_ID must be a Discord guild ID.');
    }
  }

  if (process.env.DISCORD_CLIENT_ID && !/^\d{17,20}$/.test(process.env.DISCORD_CLIENT_ID)) {
    errors.push('DISCORD_CLIENT_ID must be a Discord application ID.');
  }

  if (process.env.GUILDRANK_ENV && !VALID_ENVIRONMENTS.includes(process.env.GUILDRANK_ENV)) {
    errors.push(`GUILDRANK_ENV must be one of: ${VALID_ENVIRONMENTS.join(', ')}.`);
  }

  if (target === 'deployGlobal' && process.env.GUILDRANK_ENV && process.env.GUILDRANK_ENV !== 'production') {
    errors.push('Global command deploys are only allowed when GUILDRANK_ENV=production.');
  }

  if (target === 'deployGuild' && process.env.GUILDRANK_ENV === 'production') {
    errors.push('Guild-scoped command deploys are disabled when GUILDRANK_ENV=production.');
  }

  if (errors.length) {
    throw new Error(
      ['Invalid environment configuration:', ...errors.map(error => `- ${error}`)].join('\n')
    );
  }
}

function getRuntimeEnvironment() {
  return process.env.GUILDRANK_ENV || 'local';
}

function getInstanceId() {
  return process.env.APP_INSTANCE_ID || `${getRuntimeEnvironment()}-${os.hostname()}-${process.pid}`;
}

module.exports = {
  VALID_ENVIRONMENTS,
  validateEnvironment,
  getRuntimeEnvironment,
  getInstanceId,
};
