import { createHmac } from 'node:crypto';
import { deriveKey, safeEqual } from './crypto.js';

/**
 * Stateless signed links for email subscribers: `base64url(json).base64url(hmac)`.
 * - confirm:     double opt-in confirmation, 48 h
 * - manage:      magic-link preference page, 7 days
 * - unsubscribe: no expiry. CASL requires the unsubscribe mechanism to keep working for at least
 *                60 days after a message is sent; we never expire it.
 * Every token carries the subscriber's token_epoch; bumping the epoch revokes all outstanding links.
 */
export type TokenPurpose = 'confirm' | 'manage' | 'unsubscribe';

const TTL_SECONDS: Record<TokenPurpose, number | null> = {
  confirm: 48 * 3600,
  manage: 7 * 24 * 3600,
  unsubscribe: null,
};

interface Payload {
  s: string; // subscriber id
  p: TokenPurpose;
  e: number; // token epoch
  x: number | null; // expiry, unix seconds
}

const sign = (data: string, secret: string) =>
  createHmac('sha256', deriveKey(secret, 'link-tokens')).update(data).digest('base64url');

export function issueToken(secret: string, subscriberId: string, purpose: TokenPurpose, epoch: number, now = Date.now()) {
  const ttl = TTL_SECONDS[purpose];
  const payload: Payload = { s: subscriberId, p: purpose, e: epoch, x: ttl === null ? null : Math.floor(now / 1000) + ttl };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data, secret)}`;
}

export function verifyToken(
  secret: string,
  token: string,
  purpose: TokenPurpose,
  now = Date.now(),
): { subscriberId: string; epoch: number } | null {
  const [data, sig] = token.split('.');
  if (!data || !sig || !safeEqual(sig, sign(data, secret))) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.p !== purpose) return null;
  if (payload.x !== null && payload.x < Math.floor(now / 1000)) return null;
  return { subscriberId: payload.s, epoch: payload.e };
}
