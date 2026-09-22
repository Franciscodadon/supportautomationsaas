import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDataDir } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let db;

export function getDb() {
  if (db) return db;
  ensureDataDir();
  db = new DatabaseSync(config.databasePath);
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  return db;
}

/** Runs `fn` inside a transaction, rolling back on throw. */
export function transaction(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
