import type pg from 'pg';
import { ADAPTERS } from '../channels/registry.js';
import type { ChannelAdapter, OutboxKind, OutboxRow, PublicEvent } from '../channels/types.js';
import { webhookBody } from '../channels/webhook.js';
import { CHANNEL_NAMES, type ChannelMode, type ChannelName, type Config } from '../config.js';
import { withTx, type Db, type Queryable } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { toPublicEvent, type EventRow } from './public-events.js';

export class DomainError extends Error {
  constructor(
    public code: 'not_found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

const SEVERITY_ARRAY = `array['info','low','medium','high','critical']`;

export interface EventInput {
  slug: string;
  title: string;
  summary: string;
  body?: string;
  severity: string;
  categories?: string[];
  sources?: { title: string; url: string }[];
}

async function lockEvent(tx: Queryable, id: string): Promise<EventRow> {
  const { rows } = await tx.query<EventRow>('select * from events where id = $1 for update', [id]);
  if (!rows[0]) throw new DomainError('not_found', 'event not found');
  return rows[0];
}

export async function createEvent(db: Db, actor: string, input: EventInput): Promise<EventRow> {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query<EventRow>(
      `insert into events (slug, title, summary, body, severity, categories, sources, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        input.slug,
        input.title,
        input.summary,
        input.body ?? '',
        input.severity,
        input.categories ?? [],
        JSON.stringify(input.sources ?? []),
        actor,
      ],
    );
    const ev = rows[0]!;
    await audit(tx, actor, 'event.created', 'event', ev.id, { slug: ev.slug, status: ev.status });
    return ev;
  });
}

/** Edits are only allowed before broadcast, and always clear human approval (approval is per version). */
export async function updateEvent(db: Db, actor: string, id: string, patch: Partial<EventInput>): Promise<EventRow> {
  return withTx(db, async (tx) => {
    const ev = await lockEvent(tx, id);
    if (ev.broadcast_at) throw new DomainError('conflict', 'event has been broadcast; retract it instead of editing');
    if (ev.status === 'retracted') throw new DomainError('conflict', 'event is retracted');
    const next = {
      slug: patch.slug ?? ev.slug,
      title: patch.title ?? ev.title,
      summary: patch.summary ?? ev.summary,
      body: patch.body ?? ev.body,
      severity: patch.severity ?? ev.severity,
      categories: patch.categories ?? ev.categories,
      sources: patch.sources ?? ev.sources,
    };
    const { rows } = await tx.query<EventRow>(
      `update events set slug=$2, title=$3, summary=$4, body=$5, severity=$6, categories=$7, sources=$8,
         version = version + 1, human_approved = false, approved_by = null, approved_at = null, updated_at = now()
       where id = $1 returning *`,
      [id, next.slug, next.title, next.summary, next.body, next.severity, next.categories, JSON.stringify(next.sources)],
    );
    await audit(tx, actor, 'event.updated', 'event', id, {
      fields: Object.keys(patch),
      version: rows[0]!.version,
      approval_cleared: ev.human_approved,
    });
    return rows[0]!;
  });
}

const TRANSITIONS: Record<string, string[]> = {
  draft: ['unconfirmed'],
  unconfirmed: ['draft', 'confirmed'],
  confirmed: ['unconfirmed'],
  retracted: [],
};

export async function setStatus(
  db: Db,
  config: Config,
  actor: string,
  id: string,
  status: 'draft' | 'unconfirmed' | 'confirmed',
): Promise<EventRow> {
  return withTx(db, async (tx) => {
    const ev = await lockEvent(tx, id);
    if (!TRANSITIONS[ev.status]?.includes(status)) {
      throw new DomainError('conflict', `cannot move event from ${ev.status} to ${status}`);
    }
    if (ev.broadcast_at) throw new DomainError('conflict', 'event has been broadcast; retract it instead');
    const { rows } = await tx.query<EventRow>(
      'update events set status = $2, updated_at = now() where id = $1 returning *',
      [id, status],
    );
    await audit(tx, actor, 'event.status_changed', 'event', id, { from: ev.status, to: status });
    return maybeBroadcast(tx, config, actor, rows[0]!);
  });
}

/**
 * Human approval. `expectedVersion` must match: the approver approves exactly the version they reviewed.
 * Only operators holding an admin token can call this (agents cannot).
 */
export async function approveEvent(
  db: Db,
  config: Config,
  actor: string,
  id: string,
  expectedVersion: number,
): Promise<EventRow> {
  return withTx(db, async (tx) => {
    const ev = await lockEvent(tx, id);
    if (ev.status === 'retracted') throw new DomainError('conflict', 'event is retracted');
    if (ev.version !== expectedVersion) {
      throw new DomainError('conflict', `event is at version ${ev.version}, not ${expectedVersion}; review again`);
    }
    if (ev.human_approved) return ev;
    const { rows } = await tx.query<EventRow>(
      `update events set human_approved = true, approved_by = $2, approved_at = now(), updated_at = now()
       where id = $1 returning *`,
      [id, actor],
    );
    await audit(tx, actor, 'event.approved', 'event', id, { version: ev.version, status: ev.status });
    return maybeBroadcast(tx, config, actor, rows[0]!);
  });
}

/** THE GLOBAL GATE. Broadcast happens only when status=confirmed AND human_approved=true. */
export const passesGate = (e: Pick<EventRow, 'status' | 'human_approved'>) =>
  e.status === 'confirmed' && e.human_approved === true;

async function maybeBroadcast(tx: pg.PoolClient, config: Config, actor: string, ev: EventRow): Promise<EventRow> {
  if (!passesGate(ev) || ev.broadcast_at) return ev;
  const { rows } = await tx.query<EventRow>(
    'update events set broadcast_at = now(), updated_at = now() where id = $1 returning *',
    [ev.id],
  );
  const broadcast = rows[0]!;
  const summary = await fanOut(tx, config, toPublicEvent(config, broadcast));
  await audit(tx, actor, 'event.broadcast', 'event', ev.id, { channels: summary });
  return broadcast;
}

interface EnqueueArgs {
  key: string;
  channel: ChannelName;
  kind: OutboxKind;
  eventId: string | null;
  recipientId?: string | null;
  mode: ChannelMode;
  dryRun: boolean;
  payload: Record<string, unknown>;
  status?: 'pending' | 'awaiting_operator';
  maxAttempts?: number;
  dependsOn?: string | null;
}

/** Insert an outbox row. Returns the new id, or null if the idempotency key already exists. */
export async function enqueue(db: Queryable, a: EnqueueArgs): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `insert into outbox (idempotency_key, channel, kind, event_id, recipient_id, mode, dry_run, status, payload,
                         max_attempts, depends_on)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (idempotency_key) do nothing returning id`,
    [
      a.key,
      a.channel,
      a.kind,
      a.eventId,
      a.recipientId ?? null,
      a.mode,
      a.dryRun,
      a.status ?? 'pending',
      JSON.stringify(a.payload),
      a.maxAttempts ?? 5,
      a.dependsOn ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

/**
 * Decide how a single-destination channel handles an item. An 'auto' channel that is live but missing
 * credentials degrades to the operator queue rather than silently dropping the warning.
 */
function placement(adapter: ChannelAdapter, config: Config, dryRun: boolean) {
  const mode = config.channels[adapter.name].mode;
  const missing = dryRun ? [] : adapter.missingConfig(config);
  if (mode === 'auto' && adapter.canDeliver && !missing.length) return { mode, status: 'pending' as const, missing };
  return { mode, status: 'awaiting_operator' as const, missing };
}

async function fanOut(tx: pg.PoolClient, config: Config, ev: PublicEvent): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {};
  for (const name of CHANNEL_NAMES) {
    const settings = config.channels[name];
    const adapter = ADAPTERS[name];
    if (!settings.enabled) {
      summary[name] = 'disabled';
      continue;
    }
    if (name === 'email') {
      summary[name] = await fanOutEmail(tx, ev, settings.dryRun);
    } else if (name === 'webhook') {
      summary[name] = await fanOutWebhooks(tx, config, ev, settings.dryRun);
    } else {
      const p = placement(adapter, config, settings.dryRun);
      const copy = adapter.render(ev, 'publish', config);
      await enqueue(tx, {
        key: `${name}:publish:${ev.id}`,
        channel: name,
        kind: 'publish',
        eventId: ev.id,
        mode: p.mode,
        dryRun: settings.dryRun,
        payload: { ...copy },
        status: p.status,
        maxAttempts: adapter.idempotent ? 5 : 1,
      });
      summary[name] = { mode: p.mode, status: p.status, dry_run: settings.dryRun, missing_config: p.missing };
    }
  }
  return summary;
}

const filterSql = (alias: string) => `
  ${alias}.status = $2
  and array_position(${SEVERITY_ARRAY}, ${alias}.min_severity) <= array_position(${SEVERITY_ARRAY}, $3::text)
  and (cardinality(${alias}.categories) = 0 or ${alias}.categories && $4::text[])`;

async function fanOutEmail(tx: Queryable, ev: PublicEvent, dryRun: boolean) {
  const instant = await tx.query(
    `insert into outbox (idempotency_key, channel, kind, event_id, recipient_id, mode, dry_run, status, payload, max_attempts)
     select 'email:publish:' || $1 || ':' || s.id, 'email', 'publish', $1::uuid, s.id, 'auto', $5, 'pending', '{}', 5
     from email_subscribers s
     where s.delivery = 'instant' and ${filterSql('s')}
     on conflict (idempotency_key) do nothing`,
    [ev.id, 'active', ev.severity, ev.categories, dryRun],
  );
  const digest = await tx.query(
    `insert into digest_items (subscriber_id, event_id)
     select s.id, $1::uuid from email_subscribers s
     where s.delivery = 'digest' and ${filterSql('s')}
     on conflict do nothing`,
    [ev.id, 'active', ev.severity, ev.categories],
  );
  return { instant: instant.rowCount, digest_queued: digest.rowCount, dry_run: dryRun };
}

async function fanOutWebhooks(tx: Queryable, config: Config, ev: PublicEvent, dryRun: boolean) {
  const body = webhookBody('event.published', ev);
  const res = await tx.query(
    `insert into outbox (idempotency_key, channel, kind, event_id, recipient_id, mode, dry_run, status, payload, max_attempts)
     select 'webhook:publish:' || $1 || ':' || w.id, 'webhook', 'publish', $1::uuid, w.id, 'auto', $5, 'pending',
            jsonb_build_object('body', $6::text), $7
     from webhook_endpoints w
     where ${filterSql('w')}
     on conflict (idempotency_key) do nothing`,
    [ev.id, 'active', ev.severity, ev.categories, dryRun, body, config.webhooks.maxAttempts],
  );
  return { endpoints: res.rowCount, dry_run: dryRun };
}

/**
 * Retraction. Propagates to every adapter:
 *  - publish items not yet sent (pending / awaiting operator) are cancelled;
 *  - every item that went out (or may have: in progress, needs review) gets a retraction item on the same
 *    channel and recipient, with the same dry-run flag as the original, threaded to the original post;
 *  - email digest items not yet bundled are dropped; bundled ones get a retraction email;
 *  - copy-only channels get retraction copy in the operator queue;
 *  - every channel's outcome is written to the audit log, including "nothing to retract".
 * Retractions ignore the channel `enabled` flag: anything that went out live gets a live retraction.
 */
export async function retractEvent(db: Db, config: Config, actor: string, id: string, reason: string) {
  return withTx(db, async (tx) => {
    const ev = await lockEvent(tx, id);
    if (ev.status === 'retracted') throw new DomainError('conflict', 'event is already retracted');
    const { rows } = await tx.query<EventRow>(
      `update events set status = 'retracted', retracted_at = now(), retraction_reason = $2, updated_at = now()
       where id = $1 returning *`,
      [id, reason],
    );
    const retracted = rows[0]!;
    await audit(tx, actor, 'event.retracted', 'event', id, { reason, was: ev.status, broadcast: !!ev.broadcast_at });
    if (!ev.broadcast_at) {
      await audit(tx, actor, 'event.retraction_fanout', 'event', id, { note: 'never broadcast; nothing to propagate' });
      return { event: retracted, summary: {} };
    }

    const pub = toPublicEvent(config, retracted);
    const summary: Record<string, { cancelled: number; retractions: number; note?: string }> = {};
    for (const name of CHANNEL_NAMES) summary[name] = { cancelled: 0, retractions: 0 };

    const cancelled = await tx.query<{ channel: ChannelName }>(
      `update outbox set status = 'cancelled', last_error = 'event retracted before delivery', updated_at = now(),
         completed_at = now()
       where event_id = $1 and kind = 'publish' and status in ('pending','awaiting_operator') returning channel`,
      [id],
    );
    for (const r of cancelled.rows) summary[r.channel]!.cancelled++;
    await tx.query('delete from digest_items where event_id = $1 and outbox_id is null', [id]);

    const delivered = await tx.query<OutboxRow>(
      `select * from outbox where event_id = $1 and kind = 'publish'
         and status in ('sent','dry_run','in_progress','needs_review')`,
      [id],
    );
    for (const orig of delivered.rows) {
      const adapter = ADAPTERS[orig.channel];
      let payload: Record<string, unknown> = {};
      if (orig.channel === 'webhook') payload = { body: webhookBody('event.retracted', pub) };
      else if (orig.channel !== 'email') payload = { ...adapter.render(pub, 'retraction', config) };
      const p = placement(adapter, config, orig.dry_run);
      const key =
        orig.channel === 'email'
          ? `email:retraction:${id}:${orig.recipient_id}`
          : `${orig.channel}:retraction:${orig.id}`;
      const newId = await enqueue(tx, {
        key,
        channel: orig.channel,
        kind: 'retraction',
        eventId: id,
        recipientId: orig.recipient_id,
        mode: p.mode,
        dryRun: orig.dry_run,
        payload,
        status: orig.channel === 'email' || orig.channel === 'webhook' ? 'pending' : p.status,
        maxAttempts: orig.channel === 'webhook' ? config.webhooks.maxAttempts : adapter.idempotent ? 5 : 1,
        dependsOn: orig.id,
      });
      if (newId) summary[orig.channel]!.retractions++;
    }

    // Subscribers who received the event inside a digest.
    const digested = await tx.query(
      `insert into outbox (idempotency_key, channel, kind, event_id, recipient_id, mode, dry_run, status, payload,
                           max_attempts, depends_on)
       select 'email:retraction:' || $1 || ':' || d.subscriber_id, 'email', 'retraction', $1::uuid, d.subscriber_id,
              'auto', o.dry_run, 'pending', '{}', 5, o.id
       from digest_items d join outbox o on o.id = d.outbox_id
       where d.event_id = $1::uuid and o.status in ('sent','dry_run','in_progress','needs_review')
       on conflict (idempotency_key) do nothing`,
      [id],
    );
    summary.email!.retractions += digested.rowCount ?? 0;

    for (const name of CHANNEL_NAMES) {
      const s = summary[name]!;
      if (!s.cancelled && !s.retractions) s.note = 'no prior delivery on this channel';
    }
    await audit(tx, actor, 'event.retraction_fanout', 'event', id, { channels: summary });
    return { event: retracted, summary };
  });
}
