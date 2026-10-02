import { describe, expect, it } from 'vitest';
import { bluesky, linkFacets } from '../../src/channels/bluesky.js';
import { graphemeLength, shortPost } from '../../src/channels/copy.js';
import { mastodon } from '../../src/channels/mastodon.js';
import { telegram } from '../../src/channels/telegram.js';
import type { PublicEvent } from '../../src/channels/types.js';
import { oauth1Header, x } from '../../src/channels/x.js';
import { whatsapp } from '../../src/channels/copy-only.js';
import { testConfig } from '../helpers.js';

const ev = (over: Partial<PublicEvent> = {}): PublicEvent => ({
  id: '11111111-1111-1111-1111-111111111111',
  slug: 'demo',
  title: 'Model weights exfiltrated via 🧨 poisoned plugin',
  summary: 'A '.repeat(600) + 'end.',
  severity: 'critical',
  categories: ['model-theft'],
  sources: [],
  url: 'https://hack-attack.ai/events/demo',
  status: 'confirmed',
  published_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  retracted_at: null,
  retraction_reason: null,
  ...over,
});

describe('channel copy', () => {
  const config = testConfig({ X_INCLUDE_URL: 'true' });

  it('fits Bluesky in 300 graphemes and keeps the URL intact', () => {
    const { text } = bluesky.render(ev(), 'publish', config);
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(text.endsWith(ev().url)).toBe(true);
    expect(text.startsWith('[CRITICAL]')).toBe(true);
  });

  it('computes Bluesky link facets in UTF-8 bytes', () => {
    const text = '🧨 alert https://x.test/a';
    const [f] = linkFacets(text, 'https://x.test/a');
    expect(Buffer.from(text).subarray(f!.index.byteStart, f!.index.byteEnd).toString()).toBe('https://x.test/a');
  });

  it('fits X in 280 with URL weighted 23, and Mastodon in 500', () => {
    const xText = x.render(ev(), 'publish', config).text;
    const url = ev().url;
    expect(xText.length - url.length + 23).toBeLessThanOrEqual(280);
    expect(mastodon.render(ev(), 'publish', config).text.length - url.length + 23).toBeLessThanOrEqual(500);
  });

  it('omits the URL on X unless X_INCLUDE_URL is set (cheaper tier)', () => {
    const text = x.render(ev(), 'publish', testConfig()).text;
    expect(text).not.toContain('https://');
  });

  it('renders retractions with the reason', () => {
    const r = ev({ status: 'retracted', retraction_reason: 'Vendor confirmed false positive' });
    expect(shortPost(r, 'retraction', { max: 300 })).toContain('RETRACTED:');
    expect(telegram.render(r, 'retraction', config).text).toContain('Vendor confirmed false positive');
  });

  it('escapes HTML for Telegram', () => {
    const { text } = telegram.render(ev({ title: '<script>alert(1)</script>' }), 'publish', config);
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');
  });

  it('gives WhatsApp an official wa.me share link, not an API call', () => {
    const c = whatsapp.render(ev(), 'publish', config);
    expect(c.shareUrl).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(whatsapp.canDeliver).toBe(false);
  });
});

describe('OAuth 1.0a signing', () => {
  it('matches the published Twitter signature example', () => {
    // Example from X/Twitter developer docs, "Creating a signature".
    const header = oauth1Header(
      'POST',
      'https://api.twitter.com/1.1/statuses/update.json',
      {
        apiKey: 'xvz1evFS4wEEPTGEFPHBog',
        apiSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
        accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      },
      'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      1318622958,
      { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    );
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });
});
