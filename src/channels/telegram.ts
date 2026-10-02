import { escapeHtml, severityLabel, truncate } from './copy.js';
import { httpFailure, networkFailure, postJson } from './http.js';
import type { ChannelAdapter } from './types.js';

/** Telegram Bot API: posts to a channel the bot administers (TELEGRAM_CHAT_ID, e.g. "@hackattack"). */
export const telegram: ChannelAdapter = {
  name: 'telegram',
  supportedModes: ['auto', 'assisted', 'manual-queue'],
  idempotent: false,
  canDeliver: true,
  missingConfig: (c) =>
    [!c.telegram.botToken && 'TELEGRAM_BOT_TOKEN', !c.telegram.chatId && 'TELEGRAM_CHAT_ID'].filter(Boolean) as string[],

  render(event, kind) {
    const head =
      kind === 'retraction'
        ? `<b>RETRACTED: ${escapeHtml(event.title)}</b>`
        : `<b>[${severityLabel(event.severity)}] ${escapeHtml(event.title)}</b>`;
    const body =
      kind === 'retraction'
        ? `Reason: ${escapeHtml(event.retraction_reason ?? '')}`
        : escapeHtml(truncate(event.summary, 3000));
    return { text: `${head}\n\n${body}\n\n${escapeHtml(event.url)}` };
  },

  async deliver(row, ctx) {
    const { botToken, chatId } = ctx.config.telegram;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: String(row.payload.text),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: false },
    };
    const replyTo = ctx.original?.external_id;
    if (replyTo) body.reply_parameters = { message_id: Number(replyTo), allow_sending_without_reply: true };
    try {
      const res = await postJson(ctx.fetch, `https://api.telegram.org/bot${botToken}/sendMessage`, body);
      if (res.status !== 200 || !res.json?.ok) return httpFailure(res.status, res.text);
      const msg = res.json.result;
      const username = msg?.chat?.username;
      return {
        ok: true,
        externalId: String(msg.message_id),
        externalUrl: username ? `https://t.me/${username}/${msg.message_id}` : undefined,
      };
    } catch (err) {
      const r = networkFailure(err);
      // Never let the bot token (it is part of the URL) leak into stored errors.
      return r.ok ? r : { ...r, error: r.error.split(botToken ?? '\0').join('[redacted]') };
    }
  },
};
