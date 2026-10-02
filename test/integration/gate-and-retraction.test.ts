import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import type { Db } from '../../src/db/pool.js';
import { approveEvent, createEvent, retractEvent, setStatus, updateEvent } from '../../src/domain/events.js';
import { runOnce } from '../../src/worker/worker.js';
import { closeDb, fakeFetch, sampleEvent, testConfig, testDb, workerDeps } from '../helpers.js';

const LIVE_SOCIAL = {
  CHANNEL_TELEGRAM_ENABLED: 'true',
  CHANNEL_TELEGRAM_DRY_RUN: 'false',
  TELEGRAM_BOT_TOKEN: 'bot-secret-token',
  TELEGRAM_CHAT_ID: '@hackattack',
  CHANNEL_MASTODON_ENABLED: 'true',
  CHANNEL_MASTODON_DRY_RUN: 'false',
  MASTODON_INSTANCE_URL: 'https://mastodon.test',
  MASTODON_ACCESS_TOKEN: 'masto',
  CHANNEL_BLUESKY_ENABLED: 'true', // dry-run by default
  CHANNEL_SUBSTACK_ENABLED: 'true',
  CHANNEL_LINKEDIN_ENABLED: 'true',
  CHANNEL_RSS_DRY_RUN: 'false',
  NETLIFY_BUILD_HOOK_URL: 'https://api.netlify.test/build_hooks/abc',
};

function socialFetch() {
  let n = 100;
  return fakeFetch((url) => {
    if (url.includes('api.telegram.org')) {
      return { status: 200, body: { ok: true, result: { message_id: ++n, chat: { username: 'hackattack' } } } };
    }
    if (url.includes('mastodon.test')) return { status: 200, body: { id: String(++n), url: `https://mastodon.test/@ha/${n}` } };
    if (url.includes('netlify.test')) return { status: 200, body: {} };
    return { status: 404, body: 'unexpected' };
  });
}

async function outbox(db: Db) {
  return (await db.query('select * from outbox order by channel, kind, created_at')).rows;
}

async function publish(db: Db, config: Config) {
  const ev = await createEvent(db, 'operator:don', sampleEvent());
  await setStatus(db, config, 'operator:don', ev.id, 'unconfirmed');
  await setStatus(db, config, 'operator:don', ev.id, 'confirmed');
  return approveEvent(db, config, 'operator:don', ev.id, ev.version);
}

describe('global broadcast gate', () => {
  let db: Db;
  const config = testConfig(LIVE_SOCIAL);
  beforeEach(async () => {
    db = await testDb();
  });
  afterAll(closeDb);

  it('does nothing until the event is confirmed AND human-approved', async () => {
    const ev = await createEvent(db, 'agent:triage', sampleEvent());
    await approveEvent(db, config, 'operator:don', ev.id, 1);
    expect(await outbox(db)).toHaveLength(0); // approved but draft

    await setStatus(db, config, 'agent:triage', ev.id, 'unconfirmed');
    expect(await outbox(db)).toHaveLength(0);

    const confirmed = await setStatus(db, config, 'agent:triage', ev.id, 'confirmed');
    expect(confirmed.broadcast_at).not.toBeNull();
    expect((await outbox(db)).length).toBeGreaterThan(0);
  });

  it('confirmed without approval never broadcasts', async () => {
    const ev = await createEvent(db, 'agent:triage', sampleEvent());
    await setStatus(db, config, 'agent:triage', ev.id, 'unconfirmed');
    const c = await setStatus(db, config, 'agent:triage', ev.id, 'confirmed');
    expect(c.broadcast_at).toBeNull();
    expect(await outbox(db)).toHaveLength(0);
  });

  it('the database refuses publish rows for unapproved events, even if application code is bypassed', async () => {
    const ev = await createEvent(db, 'agent:triage', sampleEvent());
    await expect(
      db.query(
        `insert into outbox (idempotency_key, channel, kind, event_id, mode, dry_run, payload)
         values ('x', 'telegram', 'publish', $1, 'auto', false, '{}')`,
        [ev.id],
      ),
    ).rejects.toThrow(/outbox gate/);
  });

  it('approval is bound to the reviewed version, and edits clear it', async () => {
    const ev = await createEvent(db, 'agent:triage', sampleEvent());
    const edited = await updateEvent(db, 'agent:triage', ev.id, { summary: 'changed after review' });
    await expect(approveEvent(db, config, 'operator:don', ev.id, ev.version)).rejects.toThrow(/version 2/);
    const approved = await approveEvent(db, config, 'operator:don', ev.id, edited.version);
    const again = await updateEvent(db, 'agent:triage', ev.id, { title: 'new title' });
    expect(approved.human_approved).toBe(true);
    expect(again.human_approved).toBe(false);
  });

  it('broadcast events cannot be edited', async () => {
    const ev = await publish(db, config);
    await expect(updateEvent(db, 'operator:don', ev.id, { title: 'x' })).rejects.toThrow(/retract/);
  });

  it('the worker re-checks the gate at send time and cancels', async () => {
    const ev = await publish(db, config);
    // Simulate a bad actor flipping approval directly in the database.
    await db.query('update events set human_approved = false where id = $1', [ev.id]);
    const f = socialFetch();
    const { deps } = workerDeps(db, config, { fetch: f.fetch });
    await runOnce(deps);
    expect(f.calls).toHaveLength(0);
    const rows = await outbox(db);
    expect(rows.filter((r) => r.kind === 'publish' && r.channel !== 'substack' && r.channel !== 'linkedin').every((r) => r.status === 'cancelled')).toBe(true);
  });
});

describe('distribution and retraction', () => {
  let db: Db;
  const config = testConfig(LIVE_SOCIAL);
  beforeEach(async () => {
    db = await testDb();
  });

  it('routes each channel by mode and dry-run, posts live channels, logs everything', async () => {
    const ev = await publish(db, config);
    const f = socialFetch();
    const { deps } = workerDeps(db, config, { fetch: f.fetch });
    await runOnce(deps);

    const byChannel = Object.fromEntries((await outbox(db)).map((r) => [r.channel, r]));
    expect(byChannel.telegram.status).toBe('sent');
    expect(byChannel.telegram.external_url).toMatch(/^https:\/\/t\.me\/hackattack\/\d+$/);
    expect(byChannel.mastodon.status).toBe('sent');
    expect(byChannel.rss.status).toBe('sent');
    expect(byChannel.bluesky.status).toBe('dry_run'); // dry-run default: no network call
    expect(byChannel.substack.status).toBe('awaiting_operator');
    expect(byChannel.substack.payload.text).toContain(ev.title);
    expect(byChannel.linkedin.status).toBe('awaiting_operator');
    expect(byChannel.x).toBeUndefined(); // X off without X_ENABLED
    expect(f.calls.some((c) => c.url.includes('bsky'))).toBe(false);

    // Mastodon gets an idempotency key; the Telegram bot token never lands in stored rows.
    const masto = f.calls.find((c) => c.url.includes('mastodon.test'))!;
    expect((masto.init.headers as Record<string, string>)['idempotency-key']).toBe(`mastodon:publish:${ev.id}`);
    expect(JSON.stringify(await outbox(db))).not.toContain('bot-secret-token');

    const audit = (await db.query(`select action, details from audit_log where entity_id = $1`, [ev.id])).rows;
    const broadcast = audit.find((a) => a.action === 'event.broadcast');
    expect(Object.keys(broadcast.details.channels)).toHaveLength(11); // every channel accounted for
  });

  it('is idempotent: re-running fan-out does not duplicate rows', async () => {
    const ev = await publish(db, config);
    const before = (await outbox(db)).length;
    await approveEvent(db, config, 'operator:don', ev.id, ev.version); // no-op
    expect((await outbox(db)).length).toBe(before);
  });

  it('retraction cancels unsent items and threads a retraction to every delivered item', async () => {
    const ev = await publish(db, config);
    const f = socialFetch();
    const { deps } = workerDeps(db, config, { fetch: f.fetch });
    await runOnce(deps);
    const tgOriginal = (await outbox(db)).find((r) => r.channel === 'telegram')!;

    const { summary } = await retractEvent(db, config, 'operator:don', ev.id, 'Vendor confirmed false positive');
    expect(summary.substack).toMatchObject({ cancelled: 1 });
    expect(summary.telegram).toMatchObject({ retractions: 1 });
    expect(summary.bluesky).toMatchObject({ retractions: 1 }); // dry-run original -> dry-run retraction
    expect(summary.x!.note).toMatch(/no prior delivery/);

    await runOnce(deps);
    const rows = await outbox(db);
    const retractions = rows.filter((r) => r.kind === 'retraction');
    expect(retractions.map((r) => r.channel).sort()).toEqual(['bluesky', 'mastodon', 'rss', 'telegram']);
    expect(retractions.find((r) => r.channel === 'bluesky')!.status).toBe('dry_run');
    expect(retractions.filter((r) => r.channel !== 'bluesky').every((r) => r.status === 'sent')).toBe(true);

    const tgRetraction = f.calls.filter((c) => c.url.includes('telegram')).at(-1)!;
    expect(tgRetraction.body.text).toContain('RETRACTED');
    expect(tgRetraction.body.reply_parameters.message_id).toBe(Number(tgOriginal.external_id));
    const mastoRetraction = f.calls.filter((c) => c.url.includes('mastodon')).at(-1)!;
    expect(mastoRetraction.body.in_reply_to_id).toBeDefined();

    const actions = (await db.query(`select action from audit_log where entity_id = $1 order by id`, [ev.id])).rows.map(
      (r) => r.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['event.retracted', 'event.retraction_fanout']));
  });

  it('a manually posted copy-only item gets retraction copy in the operator queue', async () => {
    const ev = await publish(db, config);
    await db.query(
      `update outbox set status = 'sent', external_url = 'https://substack.test/p/1' where channel = 'substack'`,
    );
    await retractEvent(db, config, 'operator:don', ev.id, 'Wrong vendor named');
    const { deps } = workerDeps(db, config, { fetch: socialFetch().fetch });
    await runOnce(deps);
    const r = (await outbox(db)).find((x) => x.channel === 'substack' && x.kind === 'retraction')!;
    expect(r.status).toBe('awaiting_operator');
    expect(r.payload.text).toContain('Wrong vendor named');
  });

  it('a retraction waits for an in-flight original and is skipped if the original failed', async () => {
    const ev = await publish(db, config);
    await db.query(`update outbox set status = 'in_progress', lease_until = now() + interval '1 hour' where channel = 'mastodon'`);
    await retractEvent(db, config, 'operator:don', ev.id, 'reason here');
    const { deps } = workerDeps(db, config, { fetch: socialFetch().fetch });
    await runOnce(deps);
    let r = (await outbox(db)).find((x) => x.channel === 'mastodon' && x.kind === 'retraction')!;
    expect(r.status).toBe('pending');
    await db.query(`update outbox set status = 'failed' where channel = 'mastodon' and kind = 'publish'`);
    await runOnce(deps);
    r = (await outbox(db)).find((x) => x.channel === 'mastodon' && x.kind === 'retraction')!;
    expect(r.status).toBe('skipped');
  });

  it('non-idempotent channels go to human review on an uncertain outcome instead of retrying', async () => {
    await publish(db, config);
    const f = fakeFetch((url) => {
      if (url.includes('telegram')) throw new Error('socket hang up');
      return { status: 200, body: { id: '1' } };
    });
    const { deps } = workerDeps(db, config, { fetch: f.fetch });
    await runOnce(deps);
    const tg = (await outbox(db)).find((r) => r.channel === 'telegram')!;
    expect(tg.status).toBe('needs_review');
    expect(tg.last_error).not.toContain('bot-secret-token');
  });

  it('a crashed worker lease is reclaimed: retried if idempotent, reviewed if not', async () => {
    await publish(db, config);
    await db.query(`update outbox set status = 'in_progress', lease_until = now() - interval '1 second' where channel in ('telegram','mastodon')`);
    const f = socialFetch();
    const { deps } = workerDeps(db, config, { fetch: f.fetch });
    await runOnce(deps);
    const rows = await outbox(db);
    expect(rows.find((r) => r.channel === 'telegram')!.status).toBe('needs_review');
    expect(rows.find((r) => r.channel === 'mastodon')!.status).toBe('sent');
  });
});
