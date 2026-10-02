import { randomUUID } from 'node:crypto';
import { webhookBody } from '../channels/webhook.js';
import type { Config } from '../config.js';
import { withTx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { encrypt, randomToken, safeEqual, sha256hex } from '../lib/crypto.js';
import { checkUrl, safePost, SsrfError, type OutboundPolicy } from '../lib/ssrf.js';
import { generateSecret } from '../lib/standard-webhooks.js';
import { DomainError, enqueue } from './events.js';

/**
 * Webhook onboarding: register URL -> verification challenge -> signing secret -> test event.
 *
 * Challenge: we POST {"type":"webhook.verification","timestamp":...,"data":{"challenge":"<random>"}} to the
 * URL (through the SSRF guard). The endpoint must answer 2xx with the challenge echoed back, either as
 * the raw response body or as JSON {"challenge":"<random>"}. Only then is a signing secret issued.
 */
export interface EndpointRow {
  id: string;
  url: string;
  status: 'pending_verification' | 'active' | 'disabled';
  categories: string[];
  min_severity: string;
  management_token_hash: string;
  consecutive_failures: number;
  disabled_at: Date | null;
  disabled_reason: string | null;
  verified_at: Date | null;
  created_at: Date;
}

async function runChallenge(url: string, policy: OutboundPolicy): Promise<void> {
  const challenge = randomToken(24);
  const body = webhookBody('webhook.verification', { challenge });
  let res;
  try {
    res = await safePost(url, body, { 'webhook-id': `verify_${randomUUID()}` }, policy);
  } catch (err) {
    if (err instanceof SsrfError) throw new DomainError('invalid', `URL rejected: ${err.message}`);
    throw new DomainError('invalid', `verification request failed: ${err instanceof Error ? err.message : 'error'}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new DomainError('invalid', `verification failed: endpoint returned HTTP ${res.status}`);
  }
  let echoed = res.body.trim();
  try {
    const parsed = JSON.parse(echoed);
    if (parsed && typeof parsed.challenge === 'string') echoed = parsed.challenge;
  } catch {
    /* raw body */
  }
  if (!safeEqual(echoed, challenge)) throw new DomainError('invalid', 'verification failed: challenge not echoed');
}

async function enqueueTest(db: Db, config: Config, endpointId: string) {
  return enqueue(db, {
    key: `webhook:test:${endpointId}:${randomUUID()}`,
    channel: 'webhook',
    kind: 'test',
    eventId: null,
    recipientId: endpointId,
    mode: 'auto',
    dryRun: config.channels.webhook.dryRun,
    payload: {
      body: webhookBody('test', {
        endpoint_id: endpointId,
        message: 'Test event from HACK-ATTACK. Verify the signature with your signing secret.',
      }),
    },
    maxAttempts: 3,
  });
}

export async function registerWebhook(
  db: Db,
  config: Config,
  policy: OutboundPolicy,
  input: { url: string; categories: string[]; min_severity: string },
  ip?: string,
) {
  try {
    checkUrl(input.url, policy);
  } catch (err) {
    throw new DomainError('invalid', `URL rejected: ${(err as Error).message}`);
  }
  await runChallenge(input.url, policy);

  const secret = generateSecret();
  const managementToken = randomToken(32);
  const id = await withTx(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into webhook_endpoints (url, status, categories, min_severity, secret_ciphertext, management_token_hash,
                                      verified_at, created_ip)
       values ($1, 'active', $2, $3, $4, $5, now(), $6) returning id`,
      [input.url, input.categories, input.min_severity, encrypt(secret, config.secretEncryptionKey), sha256hex(managementToken), ip ?? null],
    );
    const newId = rows[0]!.id;
    await audit(tx, 'public', 'webhook.registered', 'webhook_endpoint', newId, { host: new URL(input.url).host });
    return newId;
  });
  await enqueueTest(db, config, id);
  // The secret and management token are shown exactly once.
  return { id, status: 'active' as const, secret, management_token: managementToken };
}

export async function authEndpoint(db: Db, id: string, token: string | undefined): Promise<EndpointRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError('not_found', 'not found');
  const ep = (await db.query<EndpointRow>('select * from webhook_endpoints where id = $1', [id])).rows[0];
  // Same error for unknown id and wrong token.
  if (!ep || !token || !safeEqual(sha256hex(token), ep.management_token_hash)) {
    throw new DomainError('not_found', 'not found');
  }
  return ep;
}

export async function describeEndpoint(db: Db, ep: EndpointRow) {
  const { rows } = await db.query(
    `select id, kind, status, attempts, last_error, created_at, completed_at from outbox
     where channel = 'webhook' and recipient_id = $1 order by created_at desc limit 20`,
    [ep.id],
  );
  return {
    id: ep.id,
    url: ep.url,
    status: ep.status,
    categories: ep.categories,
    min_severity: ep.min_severity,
    consecutive_failures: ep.consecutive_failures,
    disabled_reason: ep.disabled_reason,
    recent_deliveries: rows,
  };
}

export async function sendTestEvent(db: Db, config: Config, ep: EndpointRow) {
  if (ep.status !== 'active') throw new DomainError('conflict', `endpoint is ${ep.status}; re-enable it first`);
  return { outbox_id: await enqueueTest(db, config, ep.id) };
}

/** Immediate rotation (no overlap window in v0): the old secret stops working at once. */
export async function rotateSecret(db: Db, config: Config, ep: EndpointRow) {
  const secret = generateSecret();
  await db.query('update webhook_endpoints set secret_ciphertext = $2, updated_at = now() where id = $1', [
    ep.id,
    encrypt(secret, config.secretEncryptionKey),
  ]);
  await audit(db, 'webhook-owner', 'webhook.secret_rotated', 'webhook_endpoint', ep.id);
  return { secret };
}

export async function reenableEndpoint(db: Db, config: Config, policy: OutboundPolicy, ep: EndpointRow) {
  await runChallenge(ep.url, policy);
  await db.query(
    `update webhook_endpoints set status = 'active', consecutive_failures = 0, disabled_at = null,
       disabled_reason = null, verified_at = now(), updated_at = now() where id = $1`,
    [ep.id],
  );
  await audit(db, 'webhook-owner', 'webhook.reenabled', 'webhook_endpoint', ep.id);
  await enqueueTest(db, config, ep.id);
  return { status: 'active' as const };
}

export async function updateEndpointFilters(db: Db, ep: EndpointRow, f: { categories: string[]; min_severity: string }) {
  await db.query('update webhook_endpoints set categories = $2, min_severity = $3, updated_at = now() where id = $1', [
    ep.id,
    f.categories,
    f.min_severity,
  ]);
}

export async function deleteEndpoint(db: Db, ep: EndpointRow) {
  await withTx(db, async (tx) => {
    await tx.query(
      `update outbox set status = 'cancelled', last_error = 'endpoint deleted', completed_at = now(), updated_at = now()
       where channel = 'webhook' and recipient_id = $1 and status = 'pending'`,
      [ep.id],
    );
    await tx.query('delete from webhook_endpoints where id = $1', [ep.id]);
    await audit(tx, 'webhook-owner', 'webhook.deleted', 'webhook_endpoint', ep.id, { host: new URL(ep.url).host });
  });
}
