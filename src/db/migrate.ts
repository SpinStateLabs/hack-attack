import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool, withTx, type Db } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Apply pending SQL migrations in filename order. Safe to run concurrently (advisory lock). */
export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await withTx(db, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', ['hack-attack-migrate']);
    await tx.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await tx.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.query(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
      await tx.query('insert into schema_migrations (name) values ($1)', [file]);
      applied.push(file);
      log(`applied ${file}`);
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
