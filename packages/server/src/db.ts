import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

export type Db = Database.Database;

/** Opens (creating if needed) the database and brings its schema up to date. */
export function openDatabase(filename: string): Db {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applySchema(db);
  return db;
}

function applySchema(db: Db): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === SCHEMA_VERSION) {
    return;
  }
  if (version !== 0) {
    throw new Error(`Unsupported database schema version ${version}`);
  }
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}
