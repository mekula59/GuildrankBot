require('dotenv').config();

const { REST, Routes } = require('discord.js');

const { validateEnvironment } = require('../src/utils/env');
const { getCommandPayload } = require('./commandManifest');

try {
  validateEnvironment('deployGlobal');
} catch (error) {
  console.error(`\n❌ Global command deploy failed\n${error.message}\n`);
  process.exit(1);
}

const commands = getCommandPayload();
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  console.log(`Deploying ${commands.length} command(s) globally...`);
  console.log('Global Discord deploys can take up to an hour to appear everywhere.');

  await rest.put(
    Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
    { body: commands }
  );

  console.log('✅ Global commands deployed:', commands.map(command => `/${command.name}`).join(' '));
})();
