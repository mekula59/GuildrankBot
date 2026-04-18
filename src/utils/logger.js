const { getInstanceId, getRuntimeEnvironment } = require('./env');

function sanitizeContext(context = {}) {
  const sanitized = {};

  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;

    if (value instanceof Error) {
      sanitized[key] = {
        name: value.name,
        message: value.message,
        code: value.code,
      };
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

function write(level, message, context = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    service: 'guildrank',
    env: getRuntimeEnvironment(),
    instance_id: getInstanceId(),
    message,
    ...sanitizeContext(context),
  };

  const line = JSON.stringify(payload);
  if (level === 'error' || level === 'warn') {
    console.error(line);
    return;
  }

  console.log(line);
}

module.exports = {
  debug(message, context) {
    write('debug', message, context);
  },
  info(message, context) {
    write('info', message, context);
  },
  warn(message, context) {
    write('warn', message, context);
  },
  error(message, context) {
    write('error', message, context);
  },
};
