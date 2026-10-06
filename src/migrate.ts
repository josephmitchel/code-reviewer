import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './db/client.js';

/**
 * Apply pending migrations under a Postgres advisory lock.
 *
 * One database serves every project, while the workflow's concurrency group is per reviewed repo —
 * so two repos opening a PR in the same minute both reached the migrate step at once. drizzle-kit
 * takes no lock: both read the journal, both see the same pending file, both apply it, and the loser
 * dies on `column already exists`. With `set -euo pipefail` that fails the step, so that PR gets no
 * review at all and the only explanation on the PR is a migration error.
 *
 * The lock is held on a connection of its own, so it serialises whole processes rather than
 * statements, and it is released even when a migration throws.
 */
const LOCK_CLASS = 0x636f6465; // 'code' — arbitrary but stable, so every job picks the same lock
const LOCK_KEY = 1;

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1, $2)', [LOCK_CLASS, LOCK_KEY]);
    const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
    await migrate(db, { migrationsFolder: folder });
    console.log('migrations up to date');
  } finally {
    await client.query('select pg_advisory_unlock($1, $2)', [LOCK_CLASS, LOCK_KEY]);
    client.release();
  }
}
