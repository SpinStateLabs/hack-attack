import { graphemeLength, shortPost } from './copy.js';
import { httpFailure, networkFailure, postJson } from './http.js';
import type { ChannelAdapter, DeliveryContext } from './types.js';

/**
 * Bluesky via the AT Protocol XRPC API, authenticated with an app password (never the main password).
 * external_id is stored as "<at-uri> <cid>" so retractions can reply to the original post.
 */
const MAX_GRAPHEMES = 300;

let session: { did: string; accessJwt: string; expires: number } | null = null;

async function getSession(ctx: DeliveryContext) {
  if (session && session.expires > Date.now()) return session;
  const { service, identifier, appPassword } = ctx.config.bluesky;
  const res = await postJson(ctx.fetch, `${service}/xrpc/com.atproto.server.createSession`, {
    identifier,
    password: appPassword,
  });
  if (res.status !== 200 || !res.json?.accessJwt) throw Object.assign(new Error('createSession failed'), { res });
  session = { did: res.json.did, accessJwt: res.json.accessJwt, expires: Date.now() + 30 * 60_000 };
  return session;
}

/** Link facets need UTF-8 byte offsets. */
export function linkFacets(text: string, url: string) {
  const idx = text.lastIndexOf(url);
  if (idx < 0) return [];
  const byteStart = Buffer.byteLength(text.slice(0, idx), 'utf8');
  return [
    {
      index: { byteStart, byteEnd: byteStart + Buffer.byteLength(url, 'utf8') },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
    },
  ];
}

export const bluesky: ChannelAdapter = {
  name: 'bluesky',
  supportedModes: ['auto', 'assisted', 'manual-queue'],
  idempotent: false,
  canDeliver: true,
  missingConfig: (c) =>
    [!c.bluesky.identifier && 'BLUESKY_IDENTIFIER', !c.bluesky.appPassword && 'BLUESKY_APP_PASSWORD'].filter(
      Boolean,
    ) as string[],

  render: (event, kind) => ({ text: shortPost(event, kind, { max: MAX_GRAPHEMES, measure: graphemeLength }) }),

  async deliver(row, ctx) {
    const text = String(row.payload.text);
    if (graphemeLength(text) > MAX_GRAPHEMES) {
      return { ok: false, retryable: false, error: `text exceeds ${MAX_GRAPHEMES} graphemes` };
    }
    try {
      const s = await getSession(ctx);
      const record: Record<string, unknown> = {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
        langs: ['en'],
      };
      if (ctx.event) record.facets = linkFacets(text, ctx.event.url);
      const [uri, cid] = (ctx.original?.external_id ?? '').split(' ');
      if (uri && cid) record.reply = { root: { uri, cid }, parent: { uri, cid } };
      const res = await postJson(
        ctx.fetch,
        `${ctx.config.bluesky.service}/xrpc/com.atproto.repo.createRecord`,
        { repo: s.did, collection: 'app.bsky.feed.post', record },
        { authorization: `Bearer ${s.accessJwt}` },
      );
      if (res.status === 401) session = null;
      if (res.status !== 200) return httpFailure(res.status, res.text);
      const rkey = String(res.json.uri).split('/').pop();
      return {
        ok: true,
        externalId: `${res.json.uri} ${res.json.cid}`,
        externalUrl: `https://bsky.app/profile/${s.did}/post/${rkey}`,
      };
    } catch (err: any) {
      if (err?.res) return httpFailure(err.res.status, err.res.text);
      return networkFailure(err);
    }
  },
};

export const resetBlueskySession = () => {
  session = null;
};
