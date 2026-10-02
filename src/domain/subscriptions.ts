import { randomUUID } from 'node:crypto';
import { CONSENT_TEXT_VERSION, consentText, type Subscriber } from '../channels/email.js';
import type { Config } from '../config.js';
import { withTx, type Db, type Queryable } from '../db/pool.js';
import { verifyToken } from '../lib/tokens.js';
import { DomainError, enqueue } from './events.js';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface Preferences {
  categories: string[];
  min_severity: string;
  delivery: 'instant' | 'digest';
}

async function recordConsent(
  db: Queryable,
  config: Config,
  s: Pick<Subscriber, 'id' | 'email'>,
  action: 'requested' | 'confirmed' | 'preferences_updated' | 'withdrawn',
  method: string,
  meta: RequestMeta,
  details: Record<string, unknown> = {},
) {
  await db.query(
    `insert into consent_records (subscriber_id, email, action, consent_text, consent_text_version, method, ip, user_agent, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [s.id, s.email, action, consentText(config), CONSENT_TEXT_VERSION, method, meta.ip ?? null, meta.userAgent?.slice(0, 500) ?? null, JSON.stringify(details)],
  );
}

async function sendTransactional(db: Queryable, config: Config, subscriberId: string, template: 'confirm' | 'manage-link') {
  await enqueue(db, {
    key: `email:${template}:${subscriberId}:${randomUUID()}`,
    channel: 'email',
    kind: 'transactional',
    eventId: null,
    recipientId: subscriberId,
    mode: 'auto',
    dryRun: config.channels.email.dryRun,
    payload: { template },
  });
}

/**
 * Step 1 of double opt-in. Always behaves the same from the caller's point of view (no enumeration):
 *  - new or previously unsubscribed address: stored as pending, confirmation email sent;
 *  - pending address: preferences replaced, confirmation re-sent;
 *  - active address: preferences untouched, a manage-preferences link is sent instead.
 */
export async function subscribe(db: Db, config: Config, email: string, prefs: Preferences, meta: RequestMeta) {
  await withTx(db, async (tx) => {
    const existing = (
      await tx.query<Subscriber>('select * from email_subscribers where email = $1 for update', [email])
    ).rows[0];
    if (existing?.status === 'active') {
      await sendTransactional(tx, config, existing.id, 'manage-link');
      return;
    }
    const { rows } = await tx.query<Subscriber>(
      `insert into email_subscribers (email, categories, min_severity, delivery)
       values ($1, $2, $3, $4)
       on conflict (email) do update set categories = $2, min_severity = $3, delivery = $4, status = 'pending',
         updated_at = now()
       returning *`,
      [email, prefs.categories, prefs.min_severity, prefs.delivery],
    );
    const s = rows[0]!;
    await recordConsent(tx, config, s, 'requested', 'web-form', meta, { preferences: prefs });
    await sendTransactional(tx, config, s.id, 'confirm');
  });
}

export async function confirm(db: Db, config: Config, token: string, meta: RequestMeta) {
  const t = verifyToken(config.tokenSigningKey, token, 'confirm');
  if (!t) throw new DomainError('invalid', 'link is invalid or expired');
  return withTx(db, async (tx) => {
    const s = (await tx.query<Subscriber>('select * from email_subscribers where id = $1 for update', [t.subscriberId]))
      .rows[0];
    if (!s || s.token_epoch !== t.epoch || s.status === 'unsubscribed') {
      throw new DomainError('invalid', 'link is invalid or expired');
    }
    if (s.status === 'active') return { status: 'active' as const };
    await tx.query(
      `update email_subscribers set status = 'active', confirmed_at = now(), updated_at = now() where id = $1`,
      [s.id],
    );
    await recordConsent(tx, config, s, 'confirmed', 'confirm-page', meta);
    return { status: 'active' as const };
  });
}

/**
 * Unsubscribe accepts an unsubscribe OR manage token, ignores the token epoch (an old link must still
 * work), and is idempotent. Bumping the epoch revokes outstanding confirm/manage links.
 */
export async function unsubscribe(db: Db, config: Config, token: string, method: string, meta: RequestMeta) {
  const t =
    verifyToken(config.tokenSigningKey, token, 'unsubscribe') ?? verifyToken(config.tokenSigningKey, token, 'manage');
  if (!t) throw new DomainError('invalid', 'link is invalid');
  await withTx(db, async (tx) => {
    const s = (await tx.query<Subscriber>('select * from email_subscribers where id = $1 for update', [t.subscriberId]))
      .rows[0];
    if (!s || s.status === 'unsubscribed') return;
    await tx.query(
      `update email_subscribers set status = 'unsubscribed', unsubscribed_at = now(), token_epoch = token_epoch + 1,
         updated_at = now() where id = $1`,
      [s.id],
    );
    await tx.query('delete from digest_items where subscriber_id = $1 and outbox_id is null', [s.id]);
    await recordConsent(tx, config, s, 'withdrawn', method, meta);
  });
}

async function subscriberFromManageToken(db: Queryable, config: Config, token: string): Promise<Subscriber> {
  const t = verifyToken(config.tokenSigningKey, token, 'manage');
  const s = t
    ? (await db.query<Subscriber>('select * from email_subscribers where id = $1', [t.subscriberId])).rows[0]
    : undefined;
  if (!t || !s || s.token_epoch !== t.epoch || s.status === 'unsubscribed') {
    throw new DomainError('invalid', 'link is invalid or expired; request a new one');
  }
  return s;
}

export async function getPreferences(db: Db, config: Config, token: string) {
  const s = await subscriberFromManageToken(db, config, token);
  return { email: s.email, status: s.status, categories: s.categories, min_severity: s.min_severity, delivery: s.delivery };
}

export async function updatePreferences(db: Db, config: Config, token: string, prefs: Preferences, meta: RequestMeta) {
  await withTx(db, async (tx) => {
    const s = await subscriberFromManageToken(tx, config, token);
    await tx.query(
      `update email_subscribers set categories = $2, min_severity = $3, delivery = $4, updated_at = now() where id = $1`,
      [s.id, prefs.categories, prefs.min_severity, prefs.delivery],
    );
    await recordConsent(tx, config, s, 'preferences_updated', 'manage-page', meta, { preferences: prefs });
  });
  return getPreferences(db, config, token);
}

/** "Email me a link". Silent for unknown addresses. */
export async function requestManageLink(db: Db, config: Config, email: string) {
  const s = (await db.query<Subscriber>('select * from email_subscribers where email = $1', [email])).rows[0];
  if (!s || s.status === 'unsubscribed') return;
  await sendTransactional(db, config, s.id, s.status === 'pending' ? 'confirm' : 'manage-link');
}
