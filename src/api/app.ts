import cors from '@fastify/cors';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { CONSENT_TEXT_VERSION, consentText } from '../channels/email.js';
import { ADAPTERS } from '../channels/registry.js';
import type { OutboxRow } from '../channels/types.js';
import { xEffectiveCap } from '../channels/x.js';
import { CATEGORIES, SEVERITIES, type Config } from '../config.js';
import type { Db } from '../db/pool.js';
import {
  approveEvent,
  createEvent,
  DomainError,
  retractEvent,
  setStatus,
  updateEvent,
} from '../domain/events.js';
import { feedSite, renderAtom, renderEventsJson, renderLlmsTxt, renderRss } from '../feeds/render.js';
import { getPublicEventBySlug, listPublicEvents } from '../domain/public-events.js';
import * as subs from '../domain/subscriptions.js';
import * as hooks from '../domain/webhooks.js';
import { audit } from '../lib/audit.js';
import { sha256hex } from '../lib/crypto.js';
import { rateLimit } from '../lib/rate-limit.js';
import type { OutboundPolicy } from '../lib/ssrf.js';
import type { TurnstileVerifier } from '../lib/turnstile.js';

export interface AppDeps {
  db: Db;
  config: Config;
  turnstile: TurnstileVerifier;
  webhookPolicy: OutboundPolicy;
  logger?: boolean;
}

const severity = z.enum(SEVERITIES);
const categories = z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).default([]);
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email();
const prefsSchema = z.object({
  categories,
  min_severity: severity.default('high'),
  delivery: z.enum(['instant', 'digest']).default('instant'),
});
const turnstileField = { turnstile_token: z.string().max(2048).optional() };

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function createApp(deps: AppDeps) {
  const { db, config } = deps;
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 64 * 1024, trustProxy: false });
  await app.register(cors, { origin: config.corsOrigins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });

  // RFC 8058 one-click unsubscribe posts application/x-www-form-urlencoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    if (err instanceof DomainError) {
      const code = { not_found: 404, conflict: 409, invalid: 422 }[err.code];
      return reply.code(code).send({ error: err.code, message: err.message });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err?.code === '23505') return reply.code(409).send({ error: 'conflict', message: 'already exists' });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal_error' });
  });

  /**
   * The socket address, never a request header (clients can send any header). On Netlify the function
   * adapter (src/platform/netlify.ts) sets it from the platform's client IP.
   */
  const clientIp = (req: FastifyRequest) => req.ip;
  const meta = (req: FastifyRequest): subs.RequestMeta => ({
    ip: clientIp(req),
    userAgent: req.headers['user-agent'],
  });

  async function limit(key: string, max: number, windowSec: number) {
    if (!(await rateLimit(db, key, max, windowSec))) throw new HttpError(429, 'rate_limited');
  }
  async function human(req: FastifyRequest, token: string | undefined) {
    if (!(await deps.turnstile(token, clientIp(req)))) throw new HttpError(403, 'turnstile_failed');
  }
  function operator(req: FastifyRequest): string {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    const name = token ? config.admins.get(sha256hex(token)) : undefined;
    if (!name) throw new HttpError(401, 'unauthorized');
    return `operator:${name}`;
  }

  // ---------------------------------------------------------------- health
  app.get('/healthz', async () => {
    await db.query('select 1');
    return { ok: true };
  });

  // ---------------------------------------------------------------- public, read-only
  const site = feedSite(config);
  const feed = async (reply: FastifyReply, type: string, render: (events: Awaited<ReturnType<typeof listPublicEvents>>) => string) => {
    const events = await listPublicEvents(db, config);
    return reply.header('content-type', type).header('cache-control', 'public, max-age=60').send(render(events));
  };
  app.get('/v1/public/events', async (_req, reply) => feed(reply, 'application/json; charset=utf-8', (e) => renderEventsJson(site, e)));
  app.get('/events.json', async (_req, reply) => feed(reply, 'application/json; charset=utf-8', (e) => renderEventsJson(site, e)));
  app.get('/feed.xml', async (_req, reply) => feed(reply, 'application/rss+xml; charset=utf-8', (e) => renderRss(site, e)));
  app.get('/atom.xml', async (_req, reply) => feed(reply, 'application/atom+xml; charset=utf-8', (e) => renderAtom(site, e)));
  app.get('/llms.txt', async (_req, reply) => feed(reply, 'text/plain; charset=utf-8', (e) => renderLlmsTxt(site, e)));
  app.get('/v1/public/events/:slug', async (req) => {
    const ev = await getPublicEventBySlug(db, config, (req.params as { slug: string }).slug);
    if (!ev) throw new DomainError('not_found', 'event not found');
    return ev;
  });

  // ---------------------------------------------------------------- email subscriptions
  app.post('/v1/subscriptions/email', async (req, reply) => {
    const body = z
      .object({ email: emailSchema, consent: z.literal(true), ...turnstileField })
      .merge(prefsSchema)
      .parse(req.body);
    await limit(`sub:ip:${clientIp(req)}`, 10, 3600);
    await limit(`sub:email:${sha256hex(body.email)}`, 3, 3600);
    await human(req, body.turnstile_token);
    await subs.subscribe(db, config, body.email, body, meta(req));
    return reply.code(202).send({ message: 'If this address can receive alerts, a confirmation email is on its way.' });
  });

  app.get('/v1/subscriptions/email/consent-text', async () => ({
    text: consentText(config),
    version: CONSENT_TEXT_VERSION,
  }));

  app.post('/v1/subscriptions/email/confirm', async (req) => {
    const body = z.object({ token: z.string().max(1024), ...turnstileField }).parse(req.body);
    await limit(`confirm:ip:${clientIp(req)}`, 30, 3600);
    await human(req, body.turnstile_token);
    return subs.confirm(db, config, body.token, meta(req));
  });

  app.post('/v1/subscriptions/email/manage-link', async (req, reply) => {
    const body = z.object({ email: emailSchema, ...turnstileField }).parse(req.body);
    await limit(`manage:ip:${clientIp(req)}`, 10, 3600);
    await limit(`manage:email:${sha256hex(body.email)}`, 3, 3600);
    await human(req, body.turnstile_token);
    await subs.requestManageLink(db, config, body.email);
    return reply.code(202).send({ message: 'If this address is subscribed, a link is on its way.' });
  });

  app.post('/v1/subscriptions/email/preferences/view', async (req) => {
    const body = z.object({ token: z.string().max(1024) }).parse(req.body);
    await limit(`prefs:ip:${clientIp(req)}`, 60, 3600);
    return subs.getPreferences(db, config, body.token);
  });

  app.put('/v1/subscriptions/email/preferences', async (req) => {
    const body = z.object({ token: z.string().max(1024), ...turnstileField }).merge(prefsSchema).parse(req.body);
    await limit(`prefs:ip:${clientIp(req)}`, 60, 3600);
    await human(req, body.turnstile_token);
    return subs.updatePreferences(db, config, body.token, body, meta(req));
  });

  // Unsubscribe is deliberately NOT behind Turnstile: it must always work in one step.
  app.post('/v1/subscriptions/email/unsubscribe', async (req) => {
    const body = z.object({ token: z.string().max(1024) }).parse(req.body);
    await limit(`unsub:ip:${clientIp(req)}`, 60, 3600);
    await subs.unsubscribe(db, config, body.token, 'unsubscribe-page', meta(req));
    return { status: 'unsubscribed' };
  });

  app.post('/v1/subscriptions/email/one-click', async (req) => {
    const token = z.string().max(1024).parse((req.query as Record<string, string>).token);
    await limit(`unsub:ip:${clientIp(req)}`, 60, 3600);
    await subs.unsubscribe(db, config, token, 'one-click-header', meta(req));
    return { status: 'unsubscribed' };
  });
  // A GET (e.g. a link scanner) never unsubscribes; send people to the page with a button.
  app.get('/v1/subscriptions/email/one-click', async (_req, reply) =>
    reply.redirect(`${config.siteUrl}/unsubscribe.html`),
  );

  // ---------------------------------------------------------------- webhooks
  const filters = z.object({ categories, min_severity: severity.default('high') });
  const mgmtToken = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
  };
  const endpoint = async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    await limit(`wh:mgmt:${clientIp(req)}`, 60, 3600);
    return hooks.authEndpoint(db, id, mgmtToken(req));
  };

  app.post('/v1/webhooks', async (req, reply) => {
    const body = z.object({ url: z.string().max(2048), ...turnstileField }).merge(filters).parse(req.body);
    await limit(`wh:reg:ip:${clientIp(req)}`, 5, 3600);
    await human(req, body.turnstile_token);
    let host = 'invalid';
    try {
      host = new URL(body.url).host.toLowerCase();
    } catch {
      /* rejected below */
    }
    await limit(`wh:reg:host:${host}`, 5, 3600);
    const result = await hooks.registerWebhook(db, config, deps.webhookPolicy, body, clientIp(req));
    return reply.code(201).send(result);
  });
  app.get('/v1/webhooks/:id', async (req) => hooks.describeEndpoint(db, await endpoint(req)));
  app.patch('/v1/webhooks/:id', async (req) => {
    const ep = await endpoint(req);
    await hooks.updateEndpointFilters(db, ep, filters.parse(req.body));
    return hooks.describeEndpoint(db, (await hooks.authEndpoint(db, ep.id, mgmtToken(req))));
  });
  app.post('/v1/webhooks/:id/test', async (req, reply) => {
    const ep = await endpoint(req);
    await limit(`wh:test:${ep.id}`, 10, 3600);
    return reply.code(202).send(await hooks.sendTestEvent(db, config, ep));
  });
  app.post('/v1/webhooks/:id/rotate-secret', async (req) => hooks.rotateSecret(db, config, await endpoint(req)));
  app.post('/v1/webhooks/:id/enable', async (req) => {
    const ep = await endpoint(req);
    const body = z.object(turnstileField).parse(req.body ?? {});
    await human(req, body.turnstile_token);
    return hooks.reenableEndpoint(db, config, deps.webhookPolicy, ep);
  });
  app.delete('/v1/webhooks/:id', async (req, reply) => {
    await hooks.deleteEndpoint(db, await endpoint(req));
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- admin (operators only)
  const eventInput = z.object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(120),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(1000),
    body: z.string().max(50_000).optional(),
    severity,
    categories: z.array(z.enum(CATEGORIES)).default([]),
    sources: z.array(z.object({ title: z.string().max(200), url: z.string().url() })).max(20).default([]),
  });
  const idParam = (req: FastifyRequest) => z.string().uuid().parse((req.params as { id: string }).id);

  app.post('/v1/admin/events', async (req, reply) => {
    const actor = operator(req);
    return reply.code(201).send(await createEvent(db, actor, eventInput.parse(req.body)));
  });
  app.patch('/v1/admin/events/:id', async (req) => updateEvent(db, operator(req), idParam(req), eventInput.partial().parse(req.body)));
  app.get('/v1/admin/events/:id', async (req) => {
    operator(req);
    const { rows } = await db.query('select * from events where id = $1', [idParam(req)]);
    if (!rows[0]) throw new DomainError('not_found', 'event not found');
    return rows[0];
  });
  app.post('/v1/admin/events/:id/status', async (req) => {
    const actor = operator(req);
    const { status } = z.object({ status: z.enum(['draft', 'unconfirmed', 'confirmed']) }).parse(req.body);
    return setStatus(db, config, actor, idParam(req), status);
  });
  app.post('/v1/admin/events/:id/approve', async (req) => {
    const actor = operator(req);
    const { version } = z.object({ version: z.number().int().positive() }).parse(req.body);
    return approveEvent(db, config, actor, idParam(req), version);
  });
  app.post('/v1/admin/events/:id/retract', async (req) => {
    const actor = operator(req);
    const { reason } = z.object({ reason: z.string().min(3).max(1000) }).parse(req.body);
    return retractEvent(db, config, actor, idParam(req), reason);
  });
  app.get('/v1/admin/events/:id/deliveries', async (req) => {
    operator(req);
    const { rows } = await db.query(
      `select channel, kind, status, count(*)::int as count from outbox where event_id = $1
       group by channel, kind, status order by channel, kind, status`,
      [idParam(req)],
    );
    return { deliveries: rows };
  });

  // Operator queue: assisted / manual-queue copy, and items needing review.
  app.get('/v1/admin/queue', async (req) => {
    operator(req);
    const { rows } = await db.query(
      `select o.id, o.channel, o.kind, o.mode, o.status, o.dry_run, o.payload, o.last_error, o.created_at,
              e.slug, e.title
       from outbox o left join events e on e.id = o.event_id
       where o.status in ('awaiting_operator','needs_review') order by o.created_at limit 200`,
    );
    return { items: rows };
  });

  async function queueItem(id: string): Promise<OutboxRow> {
    const { rows } = await db.query<OutboxRow>('select * from outbox where id = $1', [id]);
    if (!rows[0]) throw new DomainError('not_found', 'queue item not found');
    return rows[0];
  }

  /** Assisted mode: operator reviews (optionally edits) the copy, then releases it to the adapter's API. */
  app.post('/v1/admin/outbox/:id/release', async (req) => {
    const actor = operator(req);
    const { text } = z.object({ text: z.string().min(1).max(10_000).optional() }).parse(req.body ?? {});
    const item = await queueItem(idParam(req));
    const adapter = ADAPTERS[item.channel];
    if (!['awaiting_operator', 'needs_review', 'failed'].includes(item.status)) {
      throw new DomainError('conflict', `item is ${item.status}`);
    }
    if (!adapter.canDeliver) throw new DomainError('conflict', `${item.channel} is copy-only; post by hand and mark posted`);
    const missing = item.dry_run ? [] : adapter.missingConfig(config);
    if (missing.length) throw new DomainError('conflict', `channel not configured: ${missing.join(', ')}`);
    const payload = text ? { ...item.payload, text } : item.payload;
    await db.query(
      `update outbox set status = 'pending', payload = $2, attempts = 0, next_attempt_at = now(), updated_at = now()
       where id = $1`,
      [item.id, JSON.stringify(payload)],
    );
    await audit(db, actor, 'outbox.released', 'outbox', item.id, { channel: item.channel, edited: !!text, previous: item.status });
    return { id: item.id, status: 'pending' };
  });

  app.post('/v1/admin/outbox/:id/mark-posted', async (req) => {
    const actor = operator(req);
    const { url } = z.object({ url: z.string().url().max(2048) }).parse(req.body);
    const item = await queueItem(idParam(req));
    if (!['awaiting_operator', 'needs_review'].includes(item.status)) throw new DomainError('conflict', `item is ${item.status}`);
    await db.query(
      `update outbox set status = 'sent', external_url = $2, completed_at = now(), updated_at = now() where id = $1`,
      [item.id, url],
    );
    await audit(db, actor, 'outbox.marked_posted', 'outbox', item.id, { channel: item.channel, url });
    return { id: item.id, status: 'sent' };
  });

  app.post('/v1/admin/outbox/:id/cancel', async (req) => {
    const actor = operator(req);
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    const item = await queueItem(idParam(req));
    if (!['awaiting_operator', 'needs_review', 'pending', 'failed'].includes(item.status)) {
      throw new DomainError('conflict', `item is ${item.status}`);
    }
    await db.query(
      `update outbox set status = 'cancelled', last_error = $2, completed_at = now(), updated_at = now() where id = $1`,
      [item.id, `cancelled by operator: ${reason}`],
    );
    await audit(db, actor, 'outbox.cancelled', 'outbox', item.id, { channel: item.channel, reason });
    return { id: item.id, status: 'cancelled' };
  });

  app.get('/v1/admin/spend/x', async (req) => {
    operator(req);
    const { rows } = await db.query<{ spent: string; posts: number }>(
      `select coalesce(sum(cost_usd), 0) as spent, count(*)::int as posts from channel_spend
       where channel = 'x' and occurred_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`,
    );
    return {
      month_to_date_usd: Number(rows[0]!.spent),
      posts: rows[0]!.posts,
      cap_usd: xEffectiveCap(config),
      pricing_verified_on: config.x.pricingVerifiedOn ?? null,
    };
  });

  app.get('/v1/admin/audit', async (req) => {
    operator(req);
    const q = z
      .object({ entity_id: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    const { rows } = await db.query(
      `select * from audit_log where ($1::text is null or entity_id = $1) order by id desc limit $2`,
      [q.entity_id ?? null, q.limit],
    );
    return { entries: rows };
  });

  return app;
}
