import { httpFailure, networkFailure } from './http.js';
import type { ChannelAdapter } from './types.js';

/**
 * RSS/Atom/JSON/llms.txt are pull channels: the API always serves them live, and Netlify serves a static
 * copy built from the API. "Delivering" to RSS means asking Netlify to rebuild (NETLIFY_BUILD_HOOK_URL),
 * so the static feed picks up a publish or retraction. Rebuilds are idempotent.
 */
export const rss: ChannelAdapter = {
  name: 'rss',
  supportedModes: ['auto'],
  idempotent: true,
  canDeliver: true,
  missingConfig: (c) => (c.netlifyBuildHookUrl ? [] : ['NETLIFY_BUILD_HOOK_URL']),
  render: (event, kind) => ({ text: `${kind === 'retraction' ? 'retract' : 'publish'} ${event.slug}: rebuild static feeds` }),
  async deliver(row, ctx) {
    try {
      const res = await ctx.fetch(ctx.config.netlifyBuildHookUrl!, {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return httpFailure(res.status, await res.text());
      return { ok: true };
    } catch (err) {
      return networkFailure(err);
    }
  },
};
