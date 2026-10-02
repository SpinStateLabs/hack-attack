import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import { safePost, SsrfError } from '../lib/ssrf.js';
import { signatureHeaders } from '../lib/standard-webhooks.js';
import type { ChannelAdapter, PublicEvent } from './types.js';

/**
 * Webhook delivery, signed per Standard Webhooks. The outbox row id is the `webhook-id`, so it is
 * stable across retries and receivers can de-duplicate on it. The JSON body is fixed at enqueue time.
 */
export type WebhookEventType = 'event.published' | 'event.retracted' | 'test' | 'webhook.verification';

export function webhookBody(type: WebhookEventType, data: PublicEvent | Record<string, unknown>, at = new Date()): string {
  return JSON.stringify({ type, timestamp: at.toISOString(), data });
}

export const webhook: ChannelAdapter = {
  name: 'webhook',
  supportedModes: ['auto'],
  idempotent: true,
  canDeliver: true,
  // Seconds after attempt 1, 2, ...: 5s, 5m, 30m, 2h, 5h, 10h, 10h.
  retryDelays: [5, 300, 1800, 7200, 18000, 36000, 36000],
  missingConfig: () => [],
  render: (event, kind) => ({ text: webhookBody(kind === 'retraction' ? 'event.retracted' : 'event.published', event) }),

  async deliver(row, ctx) {
    const { rows } = await ctx.db.query<{ url: string; status: string; secret_ciphertext: string | null }>(
      'select url, status, secret_ciphertext from webhook_endpoints where id = $1',
      [row.recipient_id],
    );
    const ep = rows[0];
    if (!ep || ep.status !== 'active' || !ep.secret_ciphertext) {
      return { ok: true, skipped: `endpoint ${ep ? ep.status : 'deleted'}` };
    }
    const body = String(row.payload.body);
    const secret = decrypt(ep.secret_ciphertext, ctx.config.secretEncryptionKey);
    const headers = signatureHeaders(secret, row.id, Math.floor(Date.now() / 1000), body);
    try {
      const res = await safePost(ep.url, body, headers, ctx.webhookPolicy);
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, retryable: true, error: `HTTP ${res.status}` };
    } catch (err) {
      if (err instanceof SsrfError) return { ok: false, retryable: false, error: `blocked: ${err.message}` };
      return { ok: false, retryable: true, error: `network: ${err instanceof Error ? err.message : String(err)}` };
    }
  },

  async onDelivered(row, ctx) {
    await ctx.db.query(
      'update webhook_endpoints set consecutive_failures = 0, updated_at = now() where id = $1 and consecutive_failures <> 0',
      [row.recipient_id],
    );
  },

  async onFinalFailure(row, ctx, error) {
    const { rows } = await ctx.db.query<{ consecutive_failures: number }>(
      `update webhook_endpoints set consecutive_failures = consecutive_failures + 1, updated_at = now()
       where id = $1 returning consecutive_failures`,
      [row.recipient_id],
    );
    const failures = rows[0]?.consecutive_failures ?? 0;
    if (failures >= ctx.config.webhooks.disableAfterFailures || error.startsWith('blocked:')) {
      const reason = error.startsWith('blocked:') ? error : `${failures} consecutive failed deliveries`;
      const res = await ctx.db.query(
        `update webhook_endpoints set status = 'disabled', disabled_at = now(), disabled_reason = $2, updated_at = now()
         where id = $1 and status <> 'disabled'`,
        [row.recipient_id, reason],
      );
      if (res.rowCount) await audit(ctx.db, 'system', 'webhook.auto_disabled', 'webhook_endpoint', row.recipient_id, { reason });
    }
  },
};
