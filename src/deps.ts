import { smtpTransport, unconfiguredTransport, type EmailTransport } from './channels/email-transport.js';
import type { Config } from './config.js';
import type { OutboundPolicy } from './lib/ssrf.js';

export const webhookPolicy = (config: Config): OutboundPolicy => ({
  allowHttp: config.webhooks.allowHttp,
  allowedPorts: config.webhooks.allowedPorts,
  timeoutMs: config.webhooks.timeoutMs,
});

export const emailTransport = (config: Config): EmailTransport =>
  config.sender.smtpUrl && config.sender.from ? smtpTransport(config.sender.smtpUrl, config.sender.from) : unconfiguredTransport;
