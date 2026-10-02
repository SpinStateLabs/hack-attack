import nodemailer from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export interface EmailTransport {
  send(msg: EmailMessage): Promise<{ messageId: string }>;
}

/** Any SMTP relay (SES, Postmark, Resend, etc. all offer one). Provider choice is a config decision. */
export function smtpTransport(smtpUrl: string, from: string): EmailTransport {
  const t = nodemailer.createTransport(smtpUrl);
  return {
    async send(msg) {
      const info = await t.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers });
      return { messageId: info.messageId };
    },
  };
}

/** Used when SMTP is not configured; refuses to send so nothing silently disappears. */
export const unconfiguredTransport: EmailTransport = {
  async send() {
    throw new Error('SMTP_URL / EMAIL_FROM not configured');
  },
};

/** In-memory transport for tests and local development. */
export function memoryTransport(): EmailTransport & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(msg) {
      sent.push(msg);
      return { messageId: `mem-${sent.length}` };
    },
  };
}
