import type { ChannelMode, ChannelName, Config } from '../config.js';
import type { Db } from '../db/pool.js';
import type { EmailTransport } from './email-transport.js';
import type { OutboundPolicy } from '../lib/ssrf.js';

/** The public shape of an event: what feeds, webhooks and posts are allowed to show. */
export interface PublicEvent {
  id: string;
  slug: string;
  title: string;
  summary: string;
  severity: string;
  categories: string[];
  sources: { title: string; url: string }[];
  url: string;
  status: 'confirmed' | 'retracted';
  published_at: string;
  updated_at: string;
  retracted_at: string | null;
  retraction_reason: string | null;
}

export type OutboxKind = 'publish' | 'retraction' | 'digest' | 'transactional' | 'test';
export type OutboxStatus =
  | 'pending'
  | 'in_progress'
  | 'sent'
  | 'dry_run'
  | 'awaiting_operator'
  | 'needs_review'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface OutboxRow {
  id: string;
  idempotency_key: string;
  channel: ChannelName;
  kind: OutboxKind;
  event_id: string | null;
  recipient_id: string | null;
  mode: ChannelMode;
  dry_run: boolean;
  status: OutboxStatus;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  depends_on: string | null;
  external_id: string | null;
  external_url: string | null;
}

/** Paste-ready copy. For API channels this is also exactly what gets posted. */
export interface Copy {
  text: string;
  /** Optional helper link for assisted posting (an official share/compose URL). */
  shareUrl?: string;
  /** Optional title, for long-form channels. */
  title?: string;
}

export type DeliveryResult =
  | { ok: true; externalId?: string; externalUrl?: string; costUsd?: number; skipped?: string }
  | {
      ok: false;
      retryable: boolean;
      error: string;
      /** The request may have reached the provider (timeout, connection reset after send). */
      uncertain?: boolean;
    };

export interface DeliveryContext {
  db: Db;
  config: Config;
  fetch: typeof fetch;
  email: EmailTransport;
  webhookPolicy: OutboundPolicy;
  /** For retraction rows: the publish row being retracted (if any). */
  original: OutboxRow | null;
  /** The event as currently stored (null for transactional/test rows). */
  event: PublicEvent | null;
}

export interface ChannelAdapter {
  readonly name: ChannelName;
  readonly supportedModes: readonly ChannelMode[];
  /**
   * False when a repeated call after an unknown outcome (crash, timeout) could create a duplicate
   * public post. The worker then parks the row for human review instead of retrying blindly.
   */
  readonly idempotent: boolean;
  /** False for copy-only channels: no API posting, operator posts by hand. */
  readonly canDeliver: boolean;
  /** Retry delays in seconds, indexed by attempt number (last value repeats). */
  readonly retryDelays?: readonly number[];
  /** Missing credentials etc. An unconfigured auto channel is treated as manual-queue. */
  missingConfig(config: Config): string[];
  render(event: PublicEvent, kind: 'publish' | 'retraction', config: Config): Copy;
  deliver(row: OutboxRow, ctx: DeliveryContext): Promise<DeliveryResult>;
  onDelivered?(row: OutboxRow, ctx: DeliveryContext): Promise<void>;
  onFinalFailure?(row: OutboxRow, ctx: DeliveryContext, error: string): Promise<void>;
}

export const copyOnly = async (): Promise<DeliveryResult> => ({
  ok: false,
  retryable: false,
  error: 'copy-only channel: post manually and mark the queue item as posted',
});
