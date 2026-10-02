import type { PublicEvent } from '../channels/types.js';
import type { Config } from '../config.js';
import type { Queryable } from '../db/pool.js';

export interface EventRow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  severity: string;
  categories: string[];
  sources: { title: string; url: string }[];
  status: 'draft' | 'unconfirmed' | 'confirmed' | 'retracted';
  human_approved: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  broadcast_at: Date | null;
  retracted_at: Date | null;
  retraction_reason: string | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export const eventUrl = (config: Config, slug: string) => `${config.siteUrl}/events/${slug}`;

export function toPublicEvent(config: Config, e: EventRow): PublicEvent {
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    summary: e.summary,
    severity: e.severity,
    categories: e.categories,
    sources: e.sources,
    url: eventUrl(config, e.slug),
    status: e.status === 'retracted' ? 'retracted' : 'confirmed',
    published_at: (e.broadcast_at ?? e.updated_at).toISOString(),
    updated_at: e.updated_at.toISOString(),
    retracted_at: e.retracted_at?.toISOString() ?? null,
    retraction_reason: e.retraction_reason,
  };
}

/**
 * Only events that passed the broadcast gate (broadcast_at set) are ever public. A retracted event stays
 * listed, marked retracted, so feeds and caches that saw it can see the retraction.
 */
const PUBLIC_WHERE = `broadcast_at is not null and (status = 'confirmed' and human_approved or status = 'retracted')`;

export async function listPublicEvents(db: Queryable, config: Config, limit = 100): Promise<PublicEvent[]> {
  const { rows } = await db.query<EventRow>(
    `select * from events where ${PUBLIC_WHERE} order by broadcast_at desc limit $1`,
    [limit],
  );
  return rows.map((r) => toPublicEvent(config, r));
}

export async function loadPublicEvents(db: Queryable, config: Config, ids: string[]): Promise<PublicEvent[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<EventRow>(
    `select * from events where id = any($1::uuid[]) and ${PUBLIC_WHERE} order by broadcast_at`,
    [ids],
  );
  return rows.map((r) => toPublicEvent(config, r));
}

export async function getPublicEventBySlug(db: Queryable, config: Config, slug: string): Promise<PublicEvent | null> {
  const { rows } = await db.query<EventRow>(`select * from events where slug = $1 and ${PUBLIC_WHERE}`, [slug]);
  return rows[0] ? toPublicEvent(config, rows[0]) : null;
}
