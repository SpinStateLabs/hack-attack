import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../../src/lib/crypto.js';
import { issueToken, verifyToken } from '../../src/lib/tokens.js';

const KEY = 'k'.repeat(40);
const SID = '0b5f2a1e-6c1a-4c39-9f3e-1d2b3c4d5e6f';

describe('signed link tokens', () => {
  it('round-trips and binds purpose and epoch', () => {
    const t = issueToken(KEY, SID, 'manage', 3);
    expect(verifyToken(KEY, t, 'manage')).toEqual({ subscriberId: SID, epoch: 3 });
    expect(verifyToken(KEY, t, 'confirm')).toBeNull();
    expect(verifyToken('x'.repeat(40), t, 'manage')).toBeNull();
  });

  it('rejects tampered payloads', () => {
    const t = issueToken(KEY, SID, 'manage', 1);
    const [data, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ s: 'other', p: 'manage', e: 1, x: null })).toString('base64url');
    expect(verifyToken(KEY, `${forged}.${sig}`, 'manage')).toBeNull();
    expect(verifyToken(KEY, `${data}.AAAA`, 'manage')).toBeNull();
  });

  it('expires confirm (48h) and manage (7d) tokens but never unsubscribe tokens', () => {
    const now = Date.now();
    const confirm = issueToken(KEY, SID, 'confirm', 1, now);
    const unsub = issueToken(KEY, SID, 'unsubscribe', 1, now);
    expect(verifyToken(KEY, confirm, 'confirm', now + 47 * 3600_000)).not.toBeNull();
    expect(verifyToken(KEY, confirm, 'confirm', now + 49 * 3600_000)).toBeNull();
    expect(verifyToken(KEY, unsub, 'unsubscribe', now + 5 * 365 * 24 * 3600_000)).not.toBeNull();
  });
});

describe('secret encryption', () => {
  it('round-trips and detects tampering', () => {
    const sealed = encrypt('whsec_abc', KEY);
    expect(decrypt(sealed, KEY)).toBe('whsec_abc');
    expect(() => decrypt(sealed, 'z'.repeat(40))).toThrow();
    const parts = sealed.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), KEY)).toThrow();
  });
});
