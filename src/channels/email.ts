import type { Config } from '../config.js';
import { loadPublicEvents } from '../domain/public-events.js';
import { issueToken } from '../lib/tokens.js';
import { escapeHtml, severityLabel } from './copy.js';
import type { ChannelAdapter, PublicEvent } from './types.js';
import type { EmailMessage } from './email-transport.js';

export interface Subscriber {
  id: string;
  email: string;
  status: 'pending' | 'active' | 'unsubscribed';
  categories: string[];
  min_severity: string;
  delivery: 'instant' | 'digest';
  token_epoch: number;
}

export const CONSENT_TEXT_VERSION = '2026-10-02.1';
export function consentText(config: Config): string {
  return (
    `Yes, I want to receive HACK-ATTACK security alert emails from ${config.sender.name} at the address I entered, ` +
    `filtered by the categories and severity I choose. I can withdraw consent at any time using the ` +
    `unsubscribe link in every email or by contacting ${config.sender.contactEmail ?? 'the sender'}.`
  );
}

export function subscriberLinks(config: Config, s: Subscriber) {
  const unsub = issueToken(config.tokenSigningKey, s.id, 'unsubscribe', s.token_epoch);
  const manage = issueToken(config.tokenSigningKey, s.id, 'manage', s.token_epoch);
  return {
    // Tokens go in the fragment so they never reach Netlify logs or Referer headers.
    manageUrl: `${config.siteUrl}/manage.html#token=${manage}`,
    unsubscribeUrl: `${config.siteUrl}/unsubscribe.html#token=${unsub}`,
    oneClickUrl: `${config.apiUrl}/v1/subscriptions/email/one-click?token=${encodeURIComponent(unsub)}`,
  };
}

/** CASL: sender identification, contact info and a working unsubscribe mechanism in every message. */
function footer(config: Config, s: Subscriber, transactional: boolean) {
  const links = subscriberLinks(config, s);
  const who = [config.sender.name, config.sender.postalAddress, config.sender.contactEmail].filter(Boolean).join(' · ');
  const reason = transactional
    ? 'You are receiving this because someone entered this address on hack-attack.ai. If it was not you, ignore it.'
    : 'You are receiving this because you subscribed to HACK-ATTACK alerts.';
  const text = `\n\n--\n${reason}\nManage preferences: ${links.manageUrl}\nUnsubscribe: ${links.unsubscribeUrl}\n${who}`;
  const html =
    `<hr><p style="font-size:12px;color:#555">${escapeHtml(reason)}<br>` +
    `<a href="${escapeHtml(links.manageUrl)}">Manage preferences</a> · ` +
    `<a href="${escapeHtml(links.unsubscribeUrl)}">Unsubscribe</a><br>${escapeHtml(who)}</p>`;
  return { text, html, links };
}

function eventBlock(e: PublicEvent, retraction: boolean) {
  const title = retraction ? `RETRACTED: ${e.title}` : `[${severityLabel(e.severity)}] ${e.title}`;
  const body = retraction ? `This warning has been retracted. Reason: ${e.retraction_reason ?? ''}` : e.summary;
  return {
    text: `${title}\n\n${body}\n\n${e.url}`,
    html: `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(e.url)}">${escapeHtml(e.url)}</a></p>`,
  };
}

export function buildEmail(
  config: Config,
  s: Subscriber,
  kind: 'publish' | 'retraction' | 'digest' | 'confirm' | 'manage-link',
  events: PublicEvent[],
): EmailMessage {
  const transactional = kind === 'confirm' || kind === 'manage-link';
  const f = footer(config, s, transactional);
  let subject: string;
  let text: string;
  let html: string;
  if (kind === 'confirm') {
    const token = issueToken(config.tokenSigningKey, s.id, 'confirm', s.token_epoch);
    const url = `${config.siteUrl}/confirm.html#token=${token}`;
    subject = 'Confirm your HACK-ATTACK alerts subscription';
    text = `Please confirm you want HACK-ATTACK alerts at this address:\n${url}\n\nThe link expires in 48 hours. Nothing will be sent until you confirm.`;
    html = `<p>Please confirm you want HACK-ATTACK alerts at this address.</p><p><a href="${escapeHtml(url)}">Confirm subscription</a></p><p>The link expires in 48 hours. Nothing will be sent until you confirm.</p>`;
  } else if (kind === 'manage-link') {
    subject = 'Your HACK-ATTACK preferences link';
    text = `Manage your HACK-ATTACK alert preferences:\n${f.links.manageUrl}\n\nThe link expires in 7 days.`;
    html = `<p><a href="${escapeHtml(f.links.manageUrl)}">Manage your HACK-ATTACK alert preferences</a></p><p>The link expires in 7 days.</p>`;
  } else if (kind === 'digest') {
    subject = `HACK-ATTACK digest: ${events.length} alert${events.length === 1 ? '' : 's'}`;
    const blocks = events.map((e) => eventBlock(e, e.status === 'retracted'));
    text = blocks.map((b) => b.text).join('\n\n----\n\n');
    html = blocks.map((b) => b.html).join('<hr>');
  } else {
    const e = events[0]!;
    const b = eventBlock(e, kind === 'retraction');
    subject = kind === 'retraction' ? `RETRACTED: ${e.title}` : `[${severityLabel(e.severity)}] ${e.title}`;
    text = b.text;
    html = b.html;
  }
  return {
    to: s.email,
    subject,
    text: text + f.text,
    html: `<!doctype html><html><body>${html}${f.html}</body></html>`,
    headers: {
      // RFC 8058 one-click unsubscribe (HTTPS POST, no confirmation step).
      'List-Unsubscribe': `<${f.links.oneClickUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/** Email adapter. Payload: { subscriber_id, template?, event_ids? }. Rendered at send time. */
export const email: ChannelAdapter = {
  name: 'email',
  supportedModes: ['auto'],
  // A duplicate email after a crash is acceptable; a missed warning is not.
  idempotent: true,
  canDeliver: true,
  retryDelays: [60, 300, 1800, 7200],
  missingConfig: (c) =>
    [
      !c.sender.smtpUrl && 'SMTP_URL',
      !c.sender.from && 'EMAIL_FROM',
      !c.sender.postalAddress && 'SENDER_POSTAL_ADDRESS',
      !c.sender.contactEmail && 'SENDER_CONTACT_EMAIL',
    ].filter(Boolean) as string[],
  render: (event, kind) => ({ text: eventBlock(event, kind === 'retraction').text }),

  async deliver(row, ctx) {
    const { rows } = await ctx.db.query<Subscriber>('select * from email_subscribers where id = $1', [row.recipient_id]);
    const s = rows[0];
    if (!s) return { ok: true, skipped: 'subscriber not found' };
    const template = String(row.payload.template ?? row.kind);
    const transactional = row.kind === 'transactional';
    if (!transactional && s.status !== 'active') return { ok: true, skipped: `subscriber is ${s.status}` };
    if (transactional && template === 'confirm' && s.status !== 'pending') return { ok: true, skipped: 'already confirmed' };

    let events: PublicEvent[] = [];
    if (row.kind === 'digest') {
      const ids = (row.payload.event_ids as string[]) ?? [];
      // Events retracted before the digest went out are dropped, not announced.
      events = (await loadPublicEvents(ctx.db, ctx.config, ids)).filter((e) => e.status === 'confirmed');
      if (!events.length) return { ok: true, skipped: 'nothing left to send' };
    } else if (ctx.event) {
      events = [ctx.event];
    }
    const msg = buildEmail(ctx.config, s, template as Parameters<typeof buildEmail>[2], events);
    try {
      const { messageId } = await ctx.email.send(msg);
      return { ok: true, externalId: messageId };
    } catch (err) {
      return { ok: false, retryable: true, error: `smtp: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
