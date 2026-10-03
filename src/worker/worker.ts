import { ADAPTERS } from '../channels/registry.js';
import type { DeliveryContext, DeliveryResult, OutboxRow, OutboxStatus } from '../channels/types.js';
import type { EmailTransport } from '../channels/email-transport.js';
import { xPostCost } from '../channels/x.js';
import { CHANNEL_NAMES, type Config } from '../config.js';
import { withTx, type Db } from '../db/pool.js';
import { enqueue, passesGate } from '../domain/events.js';
import { toPublicEvent, type EventRow } from '../domain/public-events.js';
import { audit } from '../lib/audit.js';
import { pruneRateLimits } from '../lib/rate-limit.js';
import type { OutboundPolicy } from '../lib/ssrf.js';

export interface WorkerDeps {
  db: Db;
  config: Config;
  fetch: typeof fetch;
  email: EmailTransport;
  webhookPolicy: OutboundPolicy;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  now?: () => Date;
}

const LEASE_SECONDS = 120;
const PER_RECIPIENT = new Set(['email', 'webhook']);
const IDEMPOTENT = CHANNEL_NAMES.filter((n) => ADAPTERS[n].idempotent);

/**
 * One pass: recover stuck rows, schedule digests, deliver a batch of due rows. No delivery starts at or after
 * `deadline` (epoch ms); claimed rows not yet started are handed back. Returns the number of rows processed.
 */
export async function runOnce(deps: WorkerDeps, batchSize = 25, deadline = Infinity): Promise<number> {
  await reclaimExpiredLeases(deps);
  await scheduleDigests(deps);
  const rows = await claim(deps.db, batchSize);
  let done = 0;
  for (const row of rows) {
    if (Date.now() >= deadline) {
      await release(deps.db, rows.slice(done));
      break;
    }
    done++;
    try {
      await processRow(deps, row);
    } catch (err) {
      // Unexpected bug: put the row back with a delay rather than losing it.
      const msg = err instanceof Error ? err.message : String(err);
      deps.log?.('worker: unexpected error', { id: row.id, error: msg });
      await finish(deps.db, row, row.attempts < row.max_attempts ? 'pending' : 'failed', { error: `internal: ${msg}` }, 60);
    }
  }
  return done;
}

async function claim(db: Db, limit: number): Promise<OutboxRow[]> {
  const { rows } = await db.query<OutboxRow>(
    `update outbox set status = 'in_progress', attempts = attempts + 1,
       lease_until = now() + make_interval(secs => $2), updated_at = now()
     where id in (
       select o.id from outbox o
       left join outbox d on d.id = o.depends_on
       where o.status = 'pending' and o.next_attempt_at <= now()
         and (o.depends_on is null or d.status not in ('pending','in_progress'))
       order by o.next_attempt_at
       limit $1
       for update of o skip locked
     ) returning *`,
    [limit, LEASE_SECONDS],
  );
  return rows;
}

/** Undo the claim on rows that were never started: back to pending, the attempt not counted. */
async function release(db: Db, rows: OutboxRow[]) {
  await db.query(
    `update outbox set status = 'pending', attempts = attempts - 1, lease_until = null, updated_at = now()
     where id = any($1::uuid[]) and status = 'in_progress'`,
    [rows.map((r) => r.id)],
  );
}

/**
 * A worker died mid-delivery. Idempotent channels are retried; for the rest the post may or may not
 * exist, so a human decides (avoids duplicate public posts).
 */
async function reclaimExpiredLeases(deps: WorkerDeps) {
  const { rows } = await deps.db.query<{ id: string; channel: string; status: string }>(
    `update outbox set
       status = case when channel = any($1::text[]) then 'pending' else 'needs_review' end,
       last_error = 'lease expired: worker stopped mid-delivery, outcome unknown',
       lease_until = null, updated_at = now()
     where status = 'in_progress' and lease_until < now()
     returning id, channel, status`,
    [IDEMPOTENT],
  );
  for (const r of rows) {
    if (r.status === 'needs_review') {
      await audit(deps.db, 'system', 'outbox.needs_review', 'outbox', r.id, { channel: r.channel, reason: 'lease expired' });
    }
  }
}

function retryDelaySeconds(row: OutboxRow): number {
  const delays = ADAPTERS[row.channel].retryDelays;
  if (delays?.length) return delays[Math.min(row.attempts - 1, delays.length - 1)]!;
  const base = Math.min(30 * 2 ** (row.attempts - 1), 6 * 3600);
  return Math.round(base * (0.8 + Math.random() * 0.4)); // +-20% jitter
}

async function finish(
  db: Db,
  row: OutboxRow,
  status: OutboxStatus,
  extra: { error?: string; externalId?: string; externalUrl?: string; costUsd?: number } = {},
  retryInSeconds = 0,
) {
  const terminal = !['pending', 'awaiting_operator', 'needs_review'].includes(status);
  await db.query(
    `update outbox set status = $2, last_error = coalesce($3, last_error), external_id = coalesce($4, external_id),
       external_url = coalesce($5, external_url), cost_usd = coalesce($6, cost_usd), lease_until = null,
       next_attempt_at = now() + make_interval(secs => $7), completed_at = case when $8 then now() else null end,
       updated_at = now()
     where id = $1`,
    [row.id, status, extra.error ?? null, extra.externalId ?? null, extra.externalUrl ?? null, extra.costUsd ?? null, retryInSeconds, terminal],
  );
}

async function processRow(deps: WorkerDeps, row: OutboxRow) {
  const { db, config } = deps;
  const adapter = ADAPTERS[row.channel];
  const audited = !PER_RECIPIENT.has(row.channel);

  let eventRow: EventRow | null = null;
  if (row.event_id) {
    const r = await db.query<EventRow>('select * from events where id = $1', [row.event_id]);
    eventRow = r.rows[0] ?? null;
  }

  // Gate, re-checked at send time: the event may have changed since it was queued.
  if (row.kind === 'publish' && (!eventRow || !passesGate(eventRow))) {
    const reason = `gate: event is ${eventRow?.status ?? 'missing'}, approved=${eventRow?.human_approved ?? false}`;
    await finish(db, row, 'cancelled', { error: reason });
    await audit(db, 'system', 'outbox.cancelled_by_gate', 'outbox', row.id, { channel: row.channel, reason });
    return;
  }

  let original: OutboxRow | null = null;
  if (row.depends_on) {
    original = (await db.query<OutboxRow>('select * from outbox where id = $1', [row.depends_on])).rows[0] ?? null;
    if (!original || ['failed', 'cancelled', 'skipped'].includes(original.status)) {
      await finish(db, row, 'skipped', { error: 'original was never delivered; nothing to retract' });
      if (audited) await audit(db, 'system', 'outbox.skipped', 'outbox', row.id, { channel: row.channel, kind: row.kind });
      return;
    }
    if (['needs_review', 'awaiting_operator'].includes(original.status)) {
      await finish(db, row, 'awaiting_operator', { error: 'original delivery outcome unknown; operator must decide' });
      return;
    }
  }

  if (row.dry_run) {
    const preview: Record<string, unknown> = { channel: row.channel, kind: row.kind };
    if (typeof row.payload.text === 'string') preview.text = row.payload.text.slice(0, 500);
    if (row.channel === 'x' && typeof row.payload.text === 'string') {
      preview.projected_cost_usd = xPostCost(config, row.payload.text).costUsd;
    }
    await finish(db, row, 'dry_run');
    if (audited) await audit(db, 'system', 'outbox.dry_run', 'outbox', row.id, preview);
    return;
  }

  const ctx: DeliveryContext = {
    db,
    config,
    fetch: deps.fetch,
    email: deps.email,
    webhookPolicy: deps.webhookPolicy,
    original,
    event: eventRow ? toPublicEvent(config, eventRow) : null,
  };

  let result: DeliveryResult;
  try {
    result = await adapter.deliver(row, ctx);
  } catch (err) {
    result = { ok: false, retryable: true, error: `adapter error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (result.ok) {
    if (result.skipped) {
      await finish(db, row, 'skipped', { error: result.skipped });
      return;
    }
    await finish(db, row, 'sent', result);
    await adapter.onDelivered?.(row, ctx);
    if (audited) {
      await audit(db, 'system', 'outbox.sent', 'outbox', row.id, {
        channel: row.channel,
        kind: row.kind,
        event_id: row.event_id,
        external_url: result.externalUrl,
        cost_usd: result.costUsd,
      });
    }
    return;
  }

  if (result.uncertain && !adapter.idempotent) {
    await finish(db, row, 'needs_review', { error: result.error });
    await audit(db, 'system', 'outbox.needs_review', 'outbox', row.id, { channel: row.channel, error: result.error });
    return;
  }
  if (result.retryable && row.attempts < row.max_attempts) {
    await finish(db, row, 'pending', { error: result.error }, retryDelaySeconds(row));
    return;
  }
  await finish(db, row, 'failed', { error: result.error });
  await adapter.onFinalFailure?.(row, ctx, result.error);
  await audit(db, 'system', 'outbox.failed', 'outbox', row.id, {
    channel: row.channel,
    kind: row.kind,
    recipient_id: row.recipient_id,
    attempts: row.attempts,
    error: result.error,
  });
}

/** Bundle queued digest items into one email per subscriber per UTC day, after DIGEST_HOUR_UTC. */
export async function scheduleDigests(deps: WorkerDeps) {
  const now = deps.now?.() ?? new Date();
  if (now.getUTCHours() < deps.config.digestHourUtc) return;
  const day = now.toISOString().slice(0, 10);
  const { rows: subs } = await deps.db.query<{ subscriber_id: string; status: string }>(
    `select distinct d.subscriber_id, s.status from digest_items d join email_subscribers s on s.id = d.subscriber_id
     where d.outbox_id is null`,
  );
  for (const { subscriber_id, status } of subs) {
    await withTx(deps.db, async (tx) => {
      if (status !== 'active') {
        await tx.query('delete from digest_items where subscriber_id = $1 and outbox_id is null', [subscriber_id]);
        return;
      }
      const items = await tx.query<{ event_id: string }>(
        'select event_id from digest_items where subscriber_id = $1 and outbox_id is null for update',
        [subscriber_id],
      );
      if (!items.rows.length) return;
      const id = await enqueue(tx, {
        key: `email:digest:${subscriber_id}:${day}`,
        channel: 'email',
        kind: 'digest',
        eventId: null,
        recipientId: subscriber_id,
        mode: 'auto',
        dryRun: deps.config.channels.email.dryRun,
        payload: { event_ids: items.rows.map((r) => r.event_id) },
      });
      if (!id) return; // today's digest already went out; these wait for tomorrow
      await tx.query('update digest_items set outbox_id = $2 where subscriber_id = $1 and outbox_id is null', [
        subscriber_id,
        id,
      ]);
    });
  }
}

export async function maintenance(deps: WorkerDeps) {
  await pruneRateLimits(deps.db);
}
