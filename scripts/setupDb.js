const { buildMigrationSqlBundle, readMigrationFiles } = require('../src/utils/migrations');

const SQL = buildMigrationSqlBundle();
const versions = readMigrationFiles().map(migration => migration.file);

console.log('\nCopy and paste the SQL below into Supabase SQL Editor:\n');
console.log('https://app.supabase.com -> Your Project -> SQL Editor -> New Query\n');
console.log('Migration order:');
versions.forEach(version => console.log(`- ${version}`));
console.log('');
console.log('-'.repeat(72));
console.log(SQL);
console.log('-'.repeat(72));
