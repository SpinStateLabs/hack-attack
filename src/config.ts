import { z } from 'zod';

/**
 * All configuration comes from environment variables. In production these are set with
 * `fly secrets set` (API + worker) or the Netlify UI (site build). Nothing secret lives in the repo.
 */

export const CHANNEL_NAMES = [
  'email',
  'webhook',
  'rss',
  'telegram',
  'bluesky',
  'mastodon',
  'x',
  'linkedin',
  'substack',
  'whatsapp',
  'truthsocial',
] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

export const CHANNEL_MODES = ['auto', 'assisted', 'manual-queue'] as const;
export type ChannelMode = (typeof CHANNEL_MODES)[number];

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * [decision needed] Category taxonomy is a placeholder. Changing it is a config change only;
 * subscribers with unknown categories keep receiving nothing for them.
 */
export const CATEGORIES = [
  'prompt-injection',
  'jailbreak',
  'agent-hijack',
  'model-supply-chain',
  'data-poisoning',
  'data-exfiltration',
  'credential-leak',
  'deepfake-fraud',
  'model-theft',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Hard ceiling on X (Twitter) API spend per calendar month (UTC), in USD. The configured cap
 * (X_MONTHLY_CAP_USD) may be lower but never higher; config loading fails if it is.
 * Raising this requires a code change and review, by design.
 */
export const X_HARD_MONTHLY_CEILING_USD = 25;

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),

  PUBLIC_SITE_URL: z.string().url().default('https://hack-attack.ai'),
  PUBLIC_API_URL: z.string().url().default('https://api.hack-attack.ai'),
  CORS_ORIGINS: csv,

  // 32+ byte secrets, base64 or hex. Generate with: openssl rand -base64 32
  TOKEN_SIGNING_KEY: z.string().min(32),
  SECRET_ENCRYPTION_KEY: z.string().min(32),

  // Comma-separated "name:sha256hex" pairs. The operator name is written to the audit log.
  ADMIN_TOKENS: csv,

  TURNSTILE_SECRET_KEY: optionalString,
  // Non-production only: skip Turnstile verification entirely.
  TURNSTILE_BYPASS: bool(false),

  // CASL: every commercial electronic message must identify the sender and give a mailing address.
  SENDER_NAME: z.string().default('HACK-ATTACK (Spin State Labs)'),
  SENDER_POSTAL_ADDRESS: optionalString,
  SENDER_CONTACT_EMAIL: optionalString,
  EMAIL_FROM: optionalString,
  SMTP_URL: optionalString,
  DIGEST_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(13),

  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  BLUESKY_SERVICE: z.string().url().default('https://bsky.social'),
  BLUESKY_IDENTIFIER: optionalString,
  BLUESKY_APP_PASSWORD: optionalString,
  MASTODON_INSTANCE_URL: optionalString,
  MASTODON_ACCESS_TOKEN: optionalString,
  NETLIFY_BUILD_HOOK_URL: optionalString,

  X_ENABLED: bool(false),
  X_MONTHLY_CAP_USD: z.coerce.number().min(0).default(10),
  // Prices are unverified defaults copied from the brief. X_PRICING_VERIFIED_ON must be set (YYYY-MM-DD)
  // by whoever checked current pricing, or the adapter refuses to post.
  X_PRICE_PER_POST_USD: z.coerce.number().min(0).default(0.015),
  X_PRICE_PER_POST_WITH_URL_USD: z.coerce.number().min(0).default(0.2),
  X_PRICING_VERIFIED_ON: optionalString,
  X_INCLUDE_URL: bool(false),
  X_API_KEY: optionalString,
  X_API_SECRET: optionalString,
  X_ACCESS_TOKEN: optionalString,
  X_ACCESS_SECRET: optionalString,

  WEBHOOK_ALLOW_HTTP: bool(false),
  WEBHOOK_ALLOWED_PORTS: csv,
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(500).max(15000).default(5000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(12).default(8),
  WEBHOOK_DISABLE_AFTER_FAILURES: z.coerce.number().int().min(1).default(5),
});

export interface ChannelSettings {
  enabled: boolean;
  mode: ChannelMode;
  dryRun: boolean;
}

/** Channels that have no official posting API we are allowed to use: copy generation only. */
export const COPY_ONLY_CHANNELS: readonly ChannelName[] = ['substack', 'whatsapp', 'truthsocial', 'linkedin'];

const DEFAULT_MODES: Record<ChannelName, ChannelMode> = {
  email: 'auto',
  webhook: 'auto',
  rss: 'auto',
  telegram: 'auto',
  bluesky: 'auto',
  mastodon: 'auto',
  x: 'auto',
  linkedin: 'manual-queue',
  substack: 'assisted',
  whatsapp: 'assisted',
  truthsocial: 'manual-queue',
};

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = EnvSchema.parse(env);
  const production = e.NODE_ENV === 'production';
  const problems: string[] = [];

  const channels = {} as Record<ChannelName, ChannelSettings>;
  for (const name of CHANNEL_NAMES) {
    const key = name.toUpperCase();
    const modeRaw = env[`CHANNEL_${key}_MODE`] ?? DEFAULT_MODES[name];
    if (!(CHANNEL_MODES as readonly string[]).includes(modeRaw)) {
      problems.push(`CHANNEL_${key}_MODE must be one of ${CHANNEL_MODES.join('|')}`);
    }
    const mode = modeRaw as ChannelMode;
    if (COPY_ONLY_CHANNELS.includes(name) && mode === 'auto') {
      problems.push(`CHANNEL_${key}_MODE=auto is not allowed: ${name} is copy-only (assisted|manual-queue)`);
    }
    const enabledRaw = env[`CHANNEL_${key}_ENABLED`];
    const dryRunRaw = env[`CHANNEL_${key}_DRY_RUN`];
    channels[name] = {
      // Pull channels and copy-only queues default on; anything that posts to a third party defaults off.
      enabled: enabledRaw === undefined ? ['email', 'webhook', 'rss'].includes(name) : enabledRaw === 'true',
      mode,
      // Dry-run is the default everywhere. Production must opt each channel out explicitly.
      dryRun: dryRunRaw === undefined ? true : dryRunRaw === 'true',
    };
  }
  // X has its own flag on top of the channel switch.
  if (!e.X_ENABLED) channels.x.enabled = false;

  if (e.X_MONTHLY_CAP_USD > X_HARD_MONTHLY_CEILING_USD) {
    problems.push(`X_MONTHLY_CAP_USD (${e.X_MONTHLY_CAP_USD}) exceeds hard ceiling ${X_HARD_MONTHLY_CEILING_USD}`);
  }
  if (production) {
    if (e.TURNSTILE_BYPASS) problems.push('TURNSTILE_BYPASS is not allowed in production');
    if (!e.TURNSTILE_SECRET_KEY) problems.push('TURNSTILE_SECRET_KEY is required in production');
    if (e.WEBHOOK_ALLOW_HTTP) problems.push('WEBHOOK_ALLOW_HTTP is not allowed in production');
    if (channels.email.enabled && !channels.email.dryRun) {
      for (const k of ['SENDER_POSTAL_ADDRESS', 'SENDER_CONTACT_EMAIL', 'EMAIL_FROM', 'SMTP_URL'] as const) {
        if (!e[k]) problems.push(`${k} is required when email is live (CASL sender identification)`);
      }
    }
  }
  if (problems.length) throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);

  const admins = new Map<string, string>(); // sha256hex -> operator name
  for (const pair of e.ADMIN_TOKENS) {
    const [name, hash] = pair.split(':');
    if (name && hash && /^[0-9a-f]{64}$/i.test(hash)) admins.set(hash.toLowerCase(), name);
  }

  const ports = e.WEBHOOK_ALLOWED_PORTS.length ? e.WEBHOOK_ALLOWED_PORTS.map(Number) : [443, 8443];
  if (e.WEBHOOK_ALLOW_HTTP && !e.WEBHOOK_ALLOWED_PORTS.length) ports.push(80, 8080);

  return {
    env: e.NODE_ENV,
    production,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    siteUrl: e.PUBLIC_SITE_URL.replace(/\/$/, ''),
    apiUrl: e.PUBLIC_API_URL.replace(/\/$/, ''),
    corsOrigins: e.CORS_ORIGINS.length ? e.CORS_ORIGINS : [e.PUBLIC_SITE_URL.replace(/\/$/, '')],
    tokenSigningKey: e.TOKEN_SIGNING_KEY,
    secretEncryptionKey: e.SECRET_ENCRYPTION_KEY,
    admins,
    turnstile: { secretKey: e.TURNSTILE_SECRET_KEY, bypass: e.TURNSTILE_BYPASS },
    sender: {
      name: e.SENDER_NAME,
      postalAddress: e.SENDER_POSTAL_ADDRESS,
      contactEmail: e.SENDER_CONTACT_EMAIL,
      from: e.EMAIL_FROM,
      smtpUrl: e.SMTP_URL,
    },
    digestHourUtc: e.DIGEST_HOUR_UTC,
    channels,
    telegram: { botToken: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID },
    bluesky: { service: e.BLUESKY_SERVICE, identifier: e.BLUESKY_IDENTIFIER, appPassword: e.BLUESKY_APP_PASSWORD },
    mastodon: { instanceUrl: e.MASTODON_INSTANCE_URL, accessToken: e.MASTODON_ACCESS_TOKEN },
    netlifyBuildHookUrl: e.NETLIFY_BUILD_HOOK_URL,
    x: {
      monthlyCapUsd: e.X_MONTHLY_CAP_USD,
      pricePerPostUsd: e.X_PRICE_PER_POST_USD,
      pricePerPostWithUrlUsd: e.X_PRICE_PER_POST_WITH_URL_USD,
      pricingVerifiedOn: e.X_PRICING_VERIFIED_ON,
      includeUrl: e.X_INCLUDE_URL,
      apiKey: e.X_API_KEY,
      apiSecret: e.X_API_SECRET,
      accessToken: e.X_ACCESS_TOKEN,
      accessSecret: e.X_ACCESS_SECRET,
    },
    webhooks: {
      allowHttp: e.WEBHOOK_ALLOW_HTTP,
      allowedPorts: ports,
      timeoutMs: e.WEBHOOK_TIMEOUT_MS,
      maxAttempts: e.WEBHOOK_MAX_ATTEMPTS,
      disableAfterFailures: e.WEBHOOK_DISABLE_AFTER_FAILURES,
    },
  };
}
