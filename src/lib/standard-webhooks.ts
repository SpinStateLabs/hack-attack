import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './crypto.js';

/**
 * Standard Webhooks signature scheme (https://www.standardwebhooks.com/):
 *   signed content = `${webhook-id}.${webhook-timestamp}.${body}`
 *   signature      = base64(HMAC-SHA256(key, signed content)), key = base64-decode(secret without "whsec_")
 *   header         = "webhook-signature: v1,<signature>" (space-separated list when rotating)
 */
const PREFIX = 'whsec_';

export function generateSecret(): string {
  return PREFIX + randomBytes(32).toString('base64');
}

function keyOf(secret: string): Buffer {
  return Buffer.from(secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret, 'base64');
}

export function sign(secret: string, msgId: string, timestampSec: number, body: string): string {
  const mac = createHmac('sha256', keyOf(secret)).update(`${msgId}.${timestampSec}.${body}`).digest('base64');
  return `v1,${mac}`;
}

export function signatureHeaders(secret: string, msgId: string, timestampSec: number, body: string) {
  return {
    'webhook-id': msgId,
    'webhook-timestamp': String(timestampSec),
    'webhook-signature': sign(secret, msgId, timestampSec, body),
  };
}

/** Receiver-side verification, published for subscribers and used in tests. */
export function verify(
  secret: string,
  headers: Record<string, string | undefined>,
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  const sigs = headers['webhook-signature'];
  if (!id || !Number.isFinite(ts) || !sigs) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = sign(secret, id, ts, body);
  return sigs.split(' ').some((s) => safeEqual(s, expected));
}
