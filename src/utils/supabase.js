const { createClient } = require('@supabase/supabase-js');
const { validateEnvironment } = require('./env');

validateEnvironment('runtime');

module.exports = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
