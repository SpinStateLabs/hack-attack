import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import type { Db } from '../../src/db/pool.js';
import { approveEvent, createEvent, setStatus } from '../../src/domain/events.js';
import { apiApp, drain, handle, workerDeps as netlifyWorkerDeps } from '../../src/platform/netlify.js';
import { runOnce } from '../../src/worker/worker.js';
import { closeDb, sampleEvent, strictPolicy, testConfig, testDb, TEST_DATABASE_URL, workerDeps } from '../helpers.js';

const config = testConfig();

async function publish(db: Db) {
  const ev = await createEvent(db, 'operator:don', sampleEvent());
  await setStatus(db, config, 'operator:don', ev.id, 'unconfirmed');
  await setStatus(db, config, 'operator:don', ev.id, 'confirmed');
  return approveEvent(db, config, 'operator:don', ev.id, 1);
}

const outbox = async (db: Db) =>
  (await db.query<{ status: string; attempts: number }>('select status, attempts from outbox order by created_at')).rows;

describe('Netlify runtime', () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
  });
  afterAll(closeDb);

  it('rate-limits sign-ups by the platform client IP, not by request headers', async () => {
    // Production config: the old code trusted Fly-Client-IP in production only.
    const prod = testConfig({ NODE_ENV: 'production', TURNSTILE_BYPASS: 'false', TURNSTILE_SECRET_KEY: 'unused' });
    const app = await createApp({ db, config: prod, turnstile: async () => true, webhookPolicy: strictPolicy });
    const signUp = (i: number, ip: string) =>
      handle(
        app,
        new Request('https://hack-attack.ai/v1/subscriptions/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}`, 'fly-client-ip': `10.0.0.${i}` },
          body: JSON.stringify({ email: `u${i}@example.org`, consent: true }),
        }),
        ip,
      ).then((r) => r.status);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push(await signUp(i, '203.0.113.1'));
    expect(codes).toEqual([...Array(10).fill(202), 429]);
    expect(await signUp(99, '203.0.113.2')).toBe(202);
  });

  it('runOnce starts no delivery at or after the deadline and hands claimed rows back unchanged', async () => {
    await publish(db);
    const before = await outbox(db);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.status === 'pending' && r.attempts === 0)).toBe(true);

    const { deps } = workerDeps(db, config);
    expect(await runOnce(deps, 25, Date.now() - 1)).toBe(0);
    expect(await outbox(db)).toEqual(before);

    expect(await drain(deps)).toBe(before.length);
    expect((await outbox(db)).every((r) => r.status === 'dry_run' && r.attempts === 1)).toBe(true);
  });

  it('serves the API and runs the worker from NETLIFY_DB_URL and the site environment', async () => {
    const keys = ['NETLIFY_DB_URL', 'TOKEN_SIGNING_KEY', 'SECRET_ENCRYPTION_KEY'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      NETLIFY_DB_URL: TEST_DATABASE_URL,
      TOKEN_SIGNING_KEY: 'test-token-signing-key-0123456789abcdef',
      SECRET_ENCRYPTION_KEY: 'test-secret-encryption-key-0123456789abcdef',
    });
    try {
      const health = await handle(await apiApp(), new Request('https://hack-attack.ai/healthz'), '198.51.100.1');
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const feed = await handle(await apiApp(), new Request('https://hack-attack.ai/v1/public/events'), '198.51.100.1');
      expect(feed.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect((await feed.json()).events).toEqual([]);

      await publish(db);
      expect(await drain(netlifyWorkerDeps())).toBeGreaterThan(0);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
