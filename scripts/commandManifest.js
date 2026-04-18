const fs = require('fs');
const path = require('path');

function getCommandPayload() {
  const commandsDir = path.join(__dirname, '..', 'src', 'commands');

  return fs.readdirSync(commandsDir)
    .filter(file => file.endsWith('.js'))
    .map(file => require(path.join(commandsDir, file)).data?.toJSON())
    .filter(Boolean);
}

module.exports = { getCommandPayload };
