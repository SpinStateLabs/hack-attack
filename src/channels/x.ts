import { createHmac, randomBytes } from 'node:crypto';
import { X_HARD_MONTHLY_CEILING_USD, type Config } from '../config.js';
import { withTx } from '../db/pool.js';
import { shortPost } from './copy.js';
import { httpFailure, networkFailure } from './http.js';
import type { ChannelAdapter } from './types.js';

/**
 * X (Twitter) API v2, OAuth 1.0a user context.
 *
 * Off unless X_ENABLED=true AND CHANNEL_X_ENABLED=true. Even then every post must pass:
 *  - X_PRICING_VERIFIED_ON is set (someone checked current per-post pricing; the defaults are unverified);
 *  - the monthly spend cap: min(X_MONTHLY_CAP_USD, X_HARD_MONTHLY_CEILING_USD in code).
 * Cost is reserved in `channel_spend` under an advisory lock BEFORE the API call, so concurrent workers
 * cannot overshoot the cap, and a post whose response was lost is still counted (we over-count, never under).
 */
const ENDPOINT = 'https://api.x.com/2/tweets';
const MAX_WEIGHT = 280;

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function oauth1Header(
  method: string,
  url: string,
  creds: { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string },
  nonce = randomBytes(16).toString('hex'),
  timestamp = Math.floor(Date.now() / 1000),
  /** Query or form parameters that are part of the signature base (not used for JSON bodies). */
  extraParams: Record<string, string> = {},
): string {
  const params: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const all: Record<string, string> = { ...extraParams, ...params };
  const paramString = Object.keys(all)
    .map((k) => [enc(k), enc(all[k]!)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = [method.toUpperCase(), enc(url), enc(paramString)].join('&');
  const key = `${enc(creds.apiSecret)}&${enc(creds.accessSecret)}`;
  params.oauth_signature = createHmac('sha1', key).update(base).digest('base64');
  return (
    'OAuth ' +
    Object.keys(params)
      .sort()
      .map((k) => `${enc(k)}="${enc(params[k]!)}"`)
      .join(', ')
  );
}

export const xEffectiveCap = (c: Config) => Math.min(c.x.monthlyCapUsd, X_HARD_MONTHLY_CEILING_USD);

export function xPostCost(c: Config, text: string): { costUsd: number; withUrl: boolean } {
  const withUrl = /https?:\/\//i.test(text);
  return { withUrl, costUsd: withUrl ? c.x.pricePerPostWithUrlUsd : c.x.pricePerPostUsd };
}

class CapExceeded extends Error {}

export const x: ChannelAdapter = {
  name: 'x',
  supportedModes: ['auto', 'assisted', 'manual-queue'],
  idempotent: false,
  canDeliver: true,
  missingConfig: (c) =>
    [
      !c.x.apiKey && 'X_API_KEY',
      !c.x.apiSecret && 'X_API_SECRET',
      !c.x.accessToken && 'X_ACCESS_TOKEN',
      !c.x.accessSecret && 'X_ACCESS_SECRET',
      !c.x.pricingVerifiedOn && 'X_PRICING_VERIFIED_ON',
    ].filter(Boolean) as string[],

  render: (event, kind, config) => ({
    text: shortPost(event, kind, {
      max: MAX_WEIGHT,
      includeUrl: config.x.includeUrl,
      urlWeight: 23,
      measure: (s) => s.length,
    }),
  }),

  async deliver(row, ctx) {
    const c = ctx.config;
    if (!c.x.pricingVerifiedOn) {
      return { ok: false, retryable: false, error: 'X_PRICING_VERIFIED_ON is not set; refusing to post' };
    }
    const text = String(row.payload.text);
    const { costUsd, withUrl } = xPostCost(c, text);
    const cap = xEffectiveCap(c);
    try {
      await withTx(ctx.db, async (tx) => {
        await tx.query(`select pg_advisory_xact_lock(hashtext('x-spend'))`);
        const { rows } = await tx.query<{ spent: string }>(
          `select coalesce(sum(cost_usd), 0) as spent from channel_spend
           where channel = 'x' and occurred_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`,
        );
        const spent = Number(rows[0]?.spent ?? 0);
        if (spent + costUsd > cap + 1e-9) {
          throw new CapExceeded(`monthly X spend cap reached: spent $${spent.toFixed(4)} + $${costUsd} > cap $${cap}`);
        }
        await tx.query(
          `insert into channel_spend (channel, outbox_id, cost_usd, with_url) values ('x', $1, $2, $3)`,
          [row.id, costUsd, withUrl],
        );
      });
    } catch (err) {
      if (err instanceof CapExceeded) return { ok: false, retryable: false, error: err.message };
      throw err;
    }

    const body: Record<string, unknown> = { text };
    if (ctx.original?.external_id) body.reply = { in_reply_to_tweet_id: ctx.original.external_id };
    try {
      const res = await ctx.fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: oauth1Header('POST', ENDPOINT, {
            apiKey: c.x.apiKey!,
            apiSecret: c.x.apiSecret!,
            accessToken: c.x.accessToken!,
            accessSecret: c.x.accessSecret!,
          }),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const resText = await res.text();
      // Retrying X is not idempotent and each attempt is billable: never auto-retry.
      if (res.status !== 201 && res.status !== 200) return { ...httpFailure(res.status, resText), retryable: false };
      const id = JSON.parse(resText)?.data?.id;
      return { ok: true, externalId: String(id), externalUrl: `https://x.com/i/web/status/${id}`, costUsd };
    } catch (err) {
      return { ...networkFailure(err), retryable: false };
    }
  },
};
