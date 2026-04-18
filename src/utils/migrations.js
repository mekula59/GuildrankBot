const fs = require('fs');
const path = require('path');

function getMigrationsDirectory() {
  return path.resolve(__dirname, '../../migrations');
}

function readMigrationFiles() {
  const directory = getMigrationsDirectory();
  return fs.readdirSync(directory)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => ({
      version: file.replace(/\.sql$/i, ''),
      file,
      fullPath: path.join(directory, file),
      sql: fs.readFileSync(path.join(directory, file), 'utf8').trim(),
    }));
}

function buildMigrationSqlBundle() {
  return readMigrationFiles()
    .map(({ file, sql }) => `-- ${file}\n${sql}`)
    .join('\n\n');
}

function listRequiredMigrationVersions() {
  return readMigrationFiles().map(migration => migration.version);
}

async function assertRequiredMigrationsApplied(supabase) {
  const requiredVersions = listRequiredMigrationVersions();

  const { data, error } = await supabase
    .from('schema_migrations')
    .select('version');

  if (error) {
    if ((error.message || '').includes('schema_migrations')) {
      throw new Error('Database migrations are missing. Run npm run setup-db and apply the printed SQL before starting GuildRank.');
    }

    throw new Error(`Failed to read schema_migrations: ${error.message}`);
  }

  const appliedVersions = new Set((data || []).map(row => row.version));
  const missingVersions = requiredVersions.filter(version => !appliedVersions.has(version));

  if (missingVersions.length) {
    throw new Error(
      `Missing database migrations: ${missingVersions.join(', ')}. Run npm run setup-db and apply the printed SQL before starting GuildRank.`
    );
  }
}

module.exports = {
  buildMigrationSqlBundle,
  readMigrationFiles,
  listRequiredMigrationVersions,
  assertRequiredMigrationsApplied,
};
