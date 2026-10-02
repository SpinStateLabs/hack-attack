import type { Queryable } from '../db/pool.js';

/**
 * Fixed-window counter in Postgres so limits hold across all API machines.
 * Returns true when the request is within the limit.
 */
export async function rateLimit(db: Queryable, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { rows } = await db.query<{ count: number }>(
    `insert into rate_limits (key, window_start, count)
     values ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     on conflict (key, window_start) do update set count = rate_limits.count + 1
     returning count`,
    [key, windowSeconds],
  );
  return (rows[0]?.count ?? Infinity) <= limit;
}

export async function pruneRateLimits(db: Queryable): Promise<void> {
  await db.query(`delete from rate_limits where window_start < now() - interval '1 day'`);
}
