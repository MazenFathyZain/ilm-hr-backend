// One-time import of data from the previous SQLite version into MariaDB.
//   npm run migrate:sqlite                 # SQLITE_FILE defaults to ./data/hr.sqlite
//   npm run migrate:sqlite -- --force      # wipe existing MariaDB data first
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { closeDb, get, initDb, run, tx } from './index.js';
import { TABLES } from './schema.js';

const file = config.sqliteFile;
if (!fs.existsSync(file)) {
  console.error(`SQLite file not found: ${file} (set SQLITE_FILE)`);
  process.exit(1);
}

const source = new DatabaseSync(file, { readOnly: true });
await initDb();

const hasData = (await get('SELECT COUNT(*) AS n FROM users')).n > 0;
if (hasData && !process.argv.includes('--force')) {
  console.error('The MariaDB database already has users. Re-run with --force to replace its data with the SQLite data.');
  await closeDb();
  process.exit(1);
}

const sourceTables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
const counts = {};

await tx(async () => {
  await run('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of TABLES) await run(`DELETE FROM ${table}`);
  for (const table of TABLES) {
    if (!sourceTables.has(table)) continue;
    const rows = source.prepare(`SELECT * FROM ${table}`).all();
    for (const row of rows) {
      const cols = Object.keys(row);
      // SQLite stored timestamps either as 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO strings – both are accepted.
      await run(
        `INSERT INTO ${table} (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        ...cols.map((c) => row[c]),
      );
    }
    counts[table] = rows.length;
  }
  await run('SET FOREIGN_KEY_CHECKS = 1');
});

console.table(counts);
console.log(`Imported ${file} into MariaDB database "${config.db.name}".`);
source.close();
await closeDb();
