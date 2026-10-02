import { shortPost } from './copy.js';
import { httpFailure, networkFailure } from './http.js';
import type { ChannelAdapter } from './types.js';

/** Mastodon REST API. The Idempotency-Key header makes retries safe on the server side. */
const MAX_CHARS = 500; // default instance limit; Mastodon counts every URL as 23 characters

export const mastodon: ChannelAdapter = {
  name: 'mastodon',
  supportedModes: ['auto', 'assisted', 'manual-queue'],
  idempotent: true,
  canDeliver: true,
  missingConfig: (c) =>
    [!c.mastodon.instanceUrl && 'MASTODON_INSTANCE_URL', !c.mastodon.accessToken && 'MASTODON_ACCESS_TOKEN'].filter(
      Boolean,
    ) as string[],

  render: (event, kind) => ({
    text: shortPost(event, kind, { max: MAX_CHARS, urlWeight: 23, measure: (s) => s.length }),
  }),

  async deliver(row, ctx) {
    const { instanceUrl, accessToken } = ctx.config.mastodon;
    const form = new URLSearchParams({ status: String(row.payload.text), visibility: 'public', language: 'en' });
    if (ctx.original?.external_id) form.set('in_reply_to_id', ctx.original.external_id);
    try {
      const res = await ctx.fetch(`${instanceUrl!.replace(/\/$/, '')}/api/v1/statuses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': row.idempotency_key },
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (res.status !== 200) return httpFailure(res.status, text);
      const json = JSON.parse(text);
      return { ok: true, externalId: String(json.id), externalUrl: json.url ?? undefined };
    } catch (err) {
      return networkFailure(err);
    }
  },
};
