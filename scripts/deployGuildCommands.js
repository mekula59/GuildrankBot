require('dotenv').config();

const { REST, Routes } = require('discord.js');

const { validateEnvironment } = require('../src/utils/env');
const { getCommandPayload } = require('./commandManifest');

try {
  validateEnvironment('deployGuild');
} catch (error) {
  console.error(`\n❌ Guild command deploy failed\n${error.message}\n`);
  process.exit(1);
}

const commands = getCommandPayload();
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  console.log(`Deploying ${commands.length} command(s) to guild ${process.env.DISCORD_DEV_GUILD_ID}...`);

  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_DEV_GUILD_ID),
    { body: commands }
  );

  console.log('✅ Guild commands deployed:', commands.map(command => `/${command.name}`).join(' '));
})();
