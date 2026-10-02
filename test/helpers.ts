import { loadConfig, type Config } from '../src/config.js';
import { memoryTransport } from '../src/channels/email-transport.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import type { OutboundPolicy } from '../src/lib/ssrf.js';
import type { WorkerDeps } from '../src/worker/worker.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/hackattack_test';

export const ADMIN_TOKEN = 'test-admin-token';
// sha256("test-admin-token")
import { createHash } from 'node:crypto';
const adminHash = createHash('sha256').update(ADMIN_TOKEN).digest('hex');

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    TOKEN_SIGNING_KEY: 'test-token-signing-key-0123456789abcdef',
    SECRET_ENCRYPTION_KEY: 'test-secret-encryption-key-0123456789abcdef',
    ADMIN_TOKENS: `don:${adminHash}`,
    PUBLIC_SITE_URL: 'https://hack-attack.test',
    PUBLIC_API_URL: 'https://api.hack-attack.test',
    TURNSTILE_BYPASS: 'true',
    SENDER_POSTAL_ADDRESS: '1 Test Street, Toronto ON, Canada',
    SENDER_CONTACT_EMAIL: 'alerts@hack-attack.test',
    EMAIL_FROM: 'alerts@hack-attack.test',
    SMTP_URL: 'smtp://unused',
    ...env,
  });
}

let pool: Db | null = null;
export async function testDb(): Promise<Db> {
  if (!pool) {
    pool = createPool(TEST_DATABASE_URL);
    await migrate(pool, () => {});
  }
  await pool.query(
    `truncate events, email_subscribers, consent_records, webhook_endpoints, outbox, digest_items, channel_spend,
       rate_limits, audit_log restart identity cascade`,
  );
  return pool;
}

export interface FetchCall {
  url: string;
  init: RequestInit;
  body: any;
}

/** Fake fetch: records calls, answers with a per-URL handler. */
export function fakeFetch(handler: (url: string, body: any, init: RequestInit) => { status: number; body: unknown }) {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    let body: any = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep string */
      }
    } else if (body instanceof URLSearchParams) {
      body = Object.fromEntries(body);
    }
    calls.push({ url, init, body });
    const r = handler(url, body, init);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const strictPolicy: OutboundPolicy = { allowHttp: false, allowedPorts: [443], timeoutMs: 2000 };

export function workerDeps(db: Db, config: Config, over: Partial<WorkerDeps> = {}) {
  const email = memoryTransport();
  return {
    email,
    deps: {
      db,
      config,
      fetch: fakeFetch(() => ({ status: 500, body: 'no handler' })).fetch,
      email,
      webhookPolicy: strictPolicy,
      ...over,
    } satisfies WorkerDeps,
  };
}

export const sampleEvent = (over: Record<string, unknown> = {}) => ({
  slug: 'prompt-injection-in-acme-agent',
  title: 'Prompt injection in Acme agent toolchain',
  summary: 'Untrusted web content can make the Acme agent run shell commands. Patch to 2.3.1.',
  severity: 'high',
  categories: ['prompt-injection'],
  sources: [{ title: 'Vendor advisory', url: 'https://example.com/advisory' }],
  ...over,
});

export async function closeDb() {
  await pool?.end();
  pool = null;
}
