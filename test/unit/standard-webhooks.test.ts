import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { generateSecret, signatureHeaders, verify } from '../../src/lib/standard-webhooks.js';

describe('Standard Webhooks signing', () => {
  const body = JSON.stringify({ type: 'event.published', data: { id: 'x' } });

  it('produces signatures the reference library accepts', () => {
    const secret = generateSecret();
    const ts = Math.floor(Date.now() / 1000);
    const headers = signatureHeaders(secret, 'msg_123', ts, body);
    expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
    // Throws on mismatch.
    expect(new Webhook(secret).verify(body, headers)).toEqual(JSON.parse(body));
  });

  it('verifies its own signatures and rejects tampering, wrong secret and stale timestamps', () => {
    const secret = generateSecret();
    const ts = Math.floor(Date.now() / 1000);
    const h = signatureHeaders(secret, 'msg_1', ts, body);
    expect(verify(secret, h, body)).toBe(true);
    expect(verify(secret, h, body + ' ')).toBe(false);
    expect(verify(generateSecret(), h, body)).toBe(false);
    expect(verify(secret, h, body, ts + 301)).toBe(false);
  });

  it('accepts any signature in a space-separated list (rotation)', () => {
    const a = generateSecret();
    const b = generateSecret();
    const ts = Math.floor(Date.now() / 1000);
    const ha = signatureHeaders(a, 'm', ts, body);
    const hb = signatureHeaders(b, 'm', ts, body);
    const both = { ...ha, 'webhook-signature': `${hb['webhook-signature']} ${ha['webhook-signature']}` };
    expect(verify(a, both, body)).toBe(true);
  });
});
