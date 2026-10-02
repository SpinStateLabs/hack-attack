import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Webhook } from 'standardwebhooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import type { Db } from '../../src/db/pool.js';
import { approveEvent, createEvent, retractEvent, setStatus } from '../../src/domain/events.js';
import type { OutboundPolicy } from '../../src/lib/ssrf.js';
import { runOnce } from '../../src/worker/worker.js';
import { ADMIN_TOKEN, closeDb, fakeFetch, sampleEvent, strictPolicy, testConfig, testDb, workerDeps } from '../helpers.js';

// --- a fake subscriber endpoint ------------------------------------------------------------
let server: http.Server;
let port = 0;
let mode: 'ok' | 'fail' | 'no-echo' = 'ok';
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      const parsed = JSON.parse(body);
      if (parsed.type === 'webhook.verification') {
        return res.end(mode === 'no-echo' ? 'nope' : JSON.stringify({ challenge: parsed.data.challenge }));
      }
      res.writeHead(mode === 'fail' ? 500 : 204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.close();
  await closeDb();
});

// Test-only: let the guard treat this loopback server as a public host called hooks.example.com.
const testPolicy = (): OutboundPolicy => ({
  allowHttp: true,
  allowedPorts: [port],
  timeoutMs: 2000,
  isAllowedAddress: (a) => a === '127.0.0.1',
  resolve: async () => [{ address: '127.0.0.1', family: 4 }],
});

describe('webhook onboarding and delivery', () => {
  let db: Db;
  const config = testConfig({ CHANNEL_WEBHOOK_DRY_RUN: 'false', WEBHOOK_MAX_ATTEMPTS: '2', WEBHOOK_DISABLE_AFTER_FAILURES: '2' });
  beforeEach(async () => {
    db = await testDb();
    received.length = 0;
    mode = 'ok';
  });
  afterEach(() => (mode = 'ok'));

  const register = async (db: Db, policy = testPolicy()) => {
    const app = await createApp({ db, config, turnstile: async () => true, webhookPolicy: policy });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      payload: { url: `http://hooks.example.com:${port}/hook`, min_severity: 'medium', turnstile_token: 't' },
    });
    return { app, res };
  };

  async function publish() {
    const ev = await createEvent(db, 'operator:don', sampleEvent());
    await setStatus(db, config, 'operator:don', ev.id, 'unconfirmed');
    await setStatus(db, config, 'operator:don', ev.id, 'confirmed');
    return approveEvent(db, config, 'operator:don', ev.id, 1);
  }

  it('register -> challenge -> secret -> signed test event', async () => {
    const { res } = await register(db);
    expect(res.statusCode).toBe(201);
    const { id, secret, management_token } = res.json();
    expect(secret).toMatch(/^whsec_/);
    expect(management_token).toBeTruthy();
    expect(JSON.parse(received[0]!.body).type).toBe('webhook.verification');

    const { deps } = workerDeps(db, config, { webhookPolicy: testPolicy() });
    await runOnce(deps);
    const test = received[1]!;
    expect(JSON.parse(test.body).type).toBe('test');
    // Verifies with the reference implementation.
    const wh = new Webhook(secret);
    expect(() => wh.verify(test.body, test.headers as Record<string, string>)).not.toThrow();
    // Secret is stored encrypted.
    const row = (await db.query('select secret_ciphertext from webhook_endpoints where id = $1', [id])).rows[0];
    expect(row.secret_ciphertext).not.toContain(secret.slice(6, 20));
  });

  it('rejects endpoints that do not echo the challenge, and issues no secret', async () => {
    mode = 'no-echo';
    const { res } = await register(db);
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/challenge/);
    expect((await db.query('select count(*)::int n from webhook_endpoints')).rows[0].n).toBe(0);
  });

  it('SSRF: refuses private destinations under the real policy', async () => {
    const app = await createApp({ db, config, turnstile: async () => true, webhookPolicy: { ...strictPolicy, allowHttp: true, allowedPorts: [port] } });
    for (const url of [`http://127.0.0.1:${port}/`, `http://169.254.169.254:${port}/`, `http://[::1]:${port}/`]) {
      const res = await app.inject({ method: 'POST', url: '/v1/webhooks', payload: { url } });
      expect(res.statusCode).toBe(422);
    }
    expect(received).toHaveLength(0);
  });

  it('delivers published and retracted events with a stable webhook-id across retries', async () => {
    await register(db);
    const { deps } = workerDeps(db, config, { webhookPolicy: testPolicy() });
    await runOnce(deps); // test event
    mode = 'fail';
    const ev = await publish();
    await runOnce(deps);
    const firstAttempt = received.at(-1)!;
    const row = (await db.query(`select * from outbox where kind = 'publish' and channel = 'webhook'`)).rows[0];
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now()); // backoff scheduled

    mode = 'ok';
    await db.query(`update outbox set next_attempt_at = now()`);
    await runOnce(deps);
    const second = received.at(-1)!;
    expect(second.headers['webhook-id']).toBe(firstAttempt.headers['webhook-id']);
    expect(JSON.parse(second.body).type).toBe('event.published');

    await retractEvent(db, config, 'operator:don', ev.id, 'false positive');
    await runOnce(deps);
    expect(JSON.parse(received.at(-1)!.body)).toMatchObject({ type: 'event.retracted', data: { status: 'retracted' } });
  });

  it('auto-disables after repeated failed deliveries and can be re-enabled by its owner', async () => {
    const { app, res } = await register(db);
    const { id, management_token } = res.json();
    const { deps } = workerDeps(db, config, { webhookPolicy: testPolicy() });
    await runOnce(deps);
    mode = 'fail';
    for (let i = 0; i < 2; i++) {
      await app.inject({ method: 'POST', url: `/v1/webhooks/${id}/test`, headers: { authorization: `Bearer ${management_token}` } });
      for (let a = 0; a < 3; a++) { // test events get 3 attempts
        await db.query(`update outbox set next_attempt_at = now() where status = 'pending'`);
        await runOnce(deps);
      }
    }
    const ep = (await db.query('select status, disabled_reason from webhook_endpoints where id = $1', [id])).rows[0];
    expect(ep).toMatchObject({ status: 'disabled', disabled_reason: '2 consecutive failed deliveries' });
    expect((await db.query(`select count(*)::int n from audit_log where action = 'webhook.auto_disabled'`)).rows[0].n).toBe(1);

    // Wrong token looks identical to unknown id.
    const denied = await app.inject({ method: 'GET', url: `/v1/webhooks/${id}`, headers: { authorization: 'Bearer nope' } });
    expect(denied.statusCode).toBe(404);

    mode = 'ok';
    const re = await app.inject({ method: 'POST', url: `/v1/webhooks/${id}/enable`, headers: { authorization: `Bearer ${management_token}` }, payload: {} });
    expect(re.json()).toEqual({ status: 'active' });
    const desc = await app.inject({ method: 'GET', url: `/v1/webhooks/${id}`, headers: { authorization: `Bearer ${management_token}` } });
    expect(desc.json()).toMatchObject({ status: 'active', consecutive_failures: 0 });
  });
});

describe('X adapter: feature flag, pricing verification, hard monthly cap', () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
  });

  const xEnv = {
    X_ENABLED: 'true',
    CHANNEL_X_ENABLED: 'true',
    CHANNEL_X_DRY_RUN: 'false',
    X_API_KEY: 'k',
    X_API_SECRET: 's',
    X_ACCESS_TOKEN: 't',
    X_ACCESS_SECRET: 'ts',
    X_PRICING_VERIFIED_ON: '2026-10-02',
    X_MONTHLY_CAP_USD: '0.03',
  };

  async function publishMany(config: ReturnType<typeof testConfig>, n: number) {
    for (let i = 0; i < n; i++) {
      const ev = await createEvent(db, 'operator:don', sampleEvent({ slug: `ev-${i}` }));
      await setStatus(db, config, 'operator:don', ev.id, 'unconfirmed');
      await setStatus(db, config, 'operator:don', ev.id, 'confirmed');
      await approveEvent(db, config, 'operator:don', ev.id, 1);
    }
  }

  it('is off unless X_ENABLED is set, even if the channel is enabled', async () => {
    const config = testConfig({ ...xEnv, X_ENABLED: 'false' });
    expect(config.channels.x.enabled).toBe(false);
  });

  it('refuses a configured cap above the hard ceiling in code', () => {
    expect(() => testConfig({ ...xEnv, X_MONTHLY_CAP_USD: '1000' })).toThrow(/hard ceiling/);
  });

  it('refuses auto mode for copy-only channels', () => {
    expect(() => testConfig({ CHANNEL_WHATSAPP_MODE: 'auto' })).toThrow(/copy-only/);
  });

  it('stops posting at the monthly cap and logs per-post cost', async () => {
    const config = testConfig(xEnv);
    let n = 0;
    const f = fakeFetch(() => ({ status: 201, body: { data: { id: String(++n), text: 'x' } } }));
    await publishMany(config, 3);
    const { deps } = workerDeps(db, config, { fetch: f.fetch });
    await runOnce(deps);
    expect(f.calls.filter((c) => c.url === 'https://api.x.com/2/tweets')).toHaveLength(2);
    const rows = (await db.query(`select status, cost_usd, last_error from outbox where channel = 'x' order by status`)).rows;
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(2);
    expect(rows.find((r) => r.status === 'failed')!.last_error).toMatch(/monthly X spend cap/);
    const spend = (await db.query(`select sum(cost_usd)::float as s, bool_or(with_url) as u from channel_spend`)).rows[0];
    expect(spend).toEqual({ s: 0.03, u: false });
    expect(f.calls[0]!.init.headers).toMatchObject({ authorization: expect.stringMatching(/^OAuth .*oauth_signature=/) });

    const app = await createApp({ db, config, turnstile: async () => true, webhookPolicy: strictPolicy });
    const r = await app.inject({ method: 'GET', url: '/v1/admin/spend/x', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(r.json()).toMatchObject({ month_to_date_usd: 0.03, posts: 2, cap_usd: 0.03 });
  });

  it('routes to the operator queue (does not post) when pricing has not been verified', async () => {
    const config = testConfig({ ...xEnv, X_PRICING_VERIFIED_ON: '' });
    const f = fakeFetch(() => ({ status: 201, body: { data: { id: '1' } } }));
    await publishMany(config, 1);
    const { deps } = workerDeps(db, config, { fetch: f.fetch });
    await runOnce(deps);
    expect(f.calls).toHaveLength(0);
    const row = (await db.query(`select status from outbox where channel = 'x'`)).rows[0];
    expect(row.status).toBe('awaiting_operator');
  });
});
