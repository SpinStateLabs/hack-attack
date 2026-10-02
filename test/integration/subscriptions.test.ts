import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import type { Db } from '../../src/db/pool.js';
import { approveEvent, createEvent, retractEvent, setStatus } from '../../src/domain/events.js';
import { runOnce, scheduleDigests } from '../../src/worker/worker.js';
import { closeDb, sampleEvent, strictPolicy, testConfig, testDb, workerDeps } from '../helpers.js';

const config = testConfig({ CHANNEL_EMAIL_DRY_RUN: 'false', DIGEST_HOUR_UTC: '0' });
const tokenFrom = (text: string, page: string) => text.match(new RegExp(`${page}\\.html#token=([^\\s]+)`))![1]!;

async function setup(db: Db, turnstile = async () => true) {
  const app = await createApp({ db, config, turnstile, webhookPolicy: strictPolicy });
  const { deps, email } = workerDeps(db, config);
  return { app, deps, email };
}

async function publish(db: Db, over: Record<string, unknown> = {}) {
  const ev = await createEvent(db, 'operator:don', sampleEvent(over));
  await setStatus(db, config, 'operator:don', ev.id, 'unconfirmed');
  await setStatus(db, config, 'operator:don', ev.id, 'confirmed');
  return approveEvent(db, config, 'operator:don', ev.id, 1);
}

describe('email double opt-in, preferences and unsubscribe', () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
  });
  afterAll(closeDb);

  async function subscribeAndConfirm(addr = 'reader@example.org', prefs: Record<string, unknown> = {}) {
    const { app, deps, email } = await setup(db);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/email',
      payload: { email: addr, consent: true, turnstile_token: 't', min_severity: 'medium', ...prefs },
    });
    expect(res.statusCode).toBe(202);
    await runOnce(deps);
    const confirmMail = email.sent.at(-1)!;
    const confirmToken = tokenFrom(confirmMail.text, 'confirm');
    const c = await app.inject({ method: 'POST', url: '/v1/subscriptions/email/confirm', payload: { token: confirmToken, turnstile_token: 't' } });
    expect(c.json()).toEqual({ status: 'active' });
    return { app, deps, email, confirmMail };
  }

  it('sends nothing but a confirmation until confirmed, then records CASL consent evidence', async () => {
    const { app, deps, email } = await setup(db);
    await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/email',
      headers: { 'user-agent': 'vitest' },
      payload: { email: 'Reader@Example.org', consent: true, turnstile_token: 't' },
    });
    await publish(db);
    await runOnce(deps);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.subject).toMatch(/Confirm/);
    expect(email.sent[0]!.to).toBe('reader@example.org');

    const token = tokenFrom(email.sent[0]!.text, 'confirm');
    await app.inject({ method: 'POST', url: '/v1/subscriptions/email/confirm', payload: { token, turnstile_token: 't' } });
    const consent = (await db.query('select action, method, consent_text, consent_text_version, user_agent from consent_records order by id')).rows;
    expect(consent.map((c) => c.action)).toEqual(['requested', 'confirmed']);
    expect(consent[0].user_agent).toBe('vitest');
    expect(consent[0].consent_text).toMatch(/withdraw consent/);
    await expect(db.query('delete from consent_records')).rejects.toThrow(/append-only/);
  });

  it('requires explicit consent and a passing Turnstile check', async () => {
    const { app } = await setup(db, async () => false);
    const noConsent = await app.inject({ method: 'POST', url: '/v1/subscriptions/email', payload: { email: 'a@b.org' } });
    expect(noConsent.statusCode).toBe(400);
    const bot = await app.inject({ method: 'POST', url: '/v1/subscriptions/email', payload: { email: 'a@b.org', consent: true } });
    expect(bot.statusCode).toBe(403);
  });

  it('rate-limits repeated sign-ups for one address', async () => {
    const { app } = await setup(db);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({ method: 'POST', url: '/v1/subscriptions/email', payload: { email: 'x@y.org', consent: true } });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([202, 202, 202, 429]);
  });

  it('delivers matching alerts with sender ID, unsubscribe link and RFC 8058 headers', async () => {
    const { deps, email } = await subscribeAndConfirm();
    await publish(db, { severity: 'low', slug: 'too-low' }); // below threshold
    await publish(db, { severity: 'critical', slug: 'critical-one' });
    await runOnce(deps);
    const alerts = email.sent.filter((m) => !/Confirm/.test(m.subject));
    expect(alerts).toHaveLength(1);
    const m = alerts[0]!;
    expect(m.subject).toMatch(/^\[CRITICAL\]/);
    expect(m.text).toContain('1 Test Street, Toronto ON, Canada');
    expect(m.text).toMatch(/unsubscribe\.html#token=/);
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m.headers['List-Unsubscribe']).toMatch(/^<https:\/\/api\.hack-attack\.test\/v1\/subscriptions\/email\/one-click\?token=/);
  });

  it('one-click unsubscribe works without Turnstile, is idempotent, and stops delivery', async () => {
    const { app, deps, email, confirmMail } = await subscribeAndConfirm();
    const url = confirmMail.headers['List-Unsubscribe']!.slice(1, -1).replace('https://api.hack-attack.test', '');
    const r1 = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(r2.statusCode).toBe(200);
    const sentBefore = email.sent.length;
    await publish(db);
    await runOnce(deps);
    expect(email.sent.length).toBe(sentBefore);
    const actions = (await db.query('select action, method from consent_records order by id')).rows;
    expect(actions.at(-1)).toEqual({ action: 'withdrawn', method: 'one-click-header' });
    // A GET (link scanner) never unsubscribes.
    const g = await app.inject({ method: 'GET', url });
    expect(g.statusCode).toBe(302);
  });

  it('magic-link preference page reads and updates preferences', async () => {
    const { app, confirmMail } = await subscribeAndConfirm();
    const token = tokenFrom(confirmMail.text, 'manage');
    const view = await app.inject({ method: 'POST', url: '/v1/subscriptions/email/preferences/view', payload: { token } });
    expect(view.json()).toMatchObject({ email: 'reader@example.org', min_severity: 'medium', delivery: 'instant' });
    const upd = await app.inject({
      method: 'PUT',
      url: '/v1/subscriptions/email/preferences',
      payload: { token, categories: ['jailbreak'], min_severity: 'critical', delivery: 'digest', turnstile_token: 't' },
    });
    expect(upd.json()).toMatchObject({ categories: ['jailbreak'], min_severity: 'critical', delivery: 'digest' });
    const bad = await app.inject({ method: 'POST', url: '/v1/subscriptions/email/preferences/view', payload: { token: token + 'x' } });
    expect(bad.statusCode).toBe(422);
  });

  it('re-subscribing an active address sends a manage link and does not change preferences (no enumeration)', async () => {
    const { app, deps, email } = await subscribeAndConfirm();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/email',
      payload: { email: 'reader@example.org', consent: true, min_severity: 'info' },
    });
    expect(r.statusCode).toBe(202);
    await runOnce(deps);
    expect(email.sent.at(-1)!.subject).toMatch(/preferences link/);
    const s = (await db.query('select min_severity from email_subscribers')).rows[0];
    expect(s.min_severity).toBe('medium');
  });

  it('digest subscribers get one bundled email; retracted-before-send items are dropped', async () => {
    const { deps, email } = await subscribeAndConfirm('digest@example.org', { delivery: 'digest' });
    await publish(db, { slug: 'one', severity: 'high' });
    const two = await publish(db, { slug: 'two', severity: 'high' });
    const three = await publish(db, { slug: 'three', severity: 'high' });
    await retractEvent(db, config, 'operator:don', three.id, 'false positive');
    await runOnce(deps);
    const digests = email.sent.filter((m) => /digest/.test(m.subject));
    expect(digests).toHaveLength(1);
    expect(digests[0]!.subject).toBe('HACK-ATTACK digest: 2 alerts');

    // After the digest went out, retracting one of its events sends a retraction email.
    await retractEvent(db, config, 'operator:don', two.id, 'duplicate of another entry');
    await runOnce(deps);
    expect(email.sent.at(-1)!.subject).toMatch(/^RETRACTED:/);
    // Same day: no second digest.
    await scheduleDigests(deps);
    expect((await db.query(`select count(*)::int as n from outbox where kind = 'digest'`)).rows[0].n).toBe(1);
  });
});
