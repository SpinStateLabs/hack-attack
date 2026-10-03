import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool, withTx, type Db } from './pool.js';

/**
 * Netlify Database's layout: one `<number>_<slug>/migration.sql` per migration. Netlify applies these itself
 * before each production deploy is published; this runner applies the same files for local dev and tests.
 */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'netlify', 'database', 'migrations');

/** Apply pending SQL migrations in directory-name order. Safe to run concurrently (advisory lock). */
export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<string[]> {
  const dirs = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const applied: string[] = [];
  await withTx(db, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', ['hack-attack-migrate']);
    await tx.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await tx.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    for (const dir of dirs) {
      if (done.has(dir)) continue;
      await tx.query(await readFile(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'));
      await tx.query('insert into schema_migrations (name) values ($1)', [dir]);
      applied.push(dir);
      log(`applied ${dir}`);
    }
  });
  return applied;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createPool(url);
  migrate(db)
    .then((a) => console.log(a.length ? `migrations applied: ${a.length}` : 'schema up to date'))
    .finally(() => db.end());
}
