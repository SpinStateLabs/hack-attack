/**
 * Netlify runtime glue. The API runs as one Netlify Function that hands each request to the Fastify app
 * (netlify/functions/api.mts); the worker runs as a scheduled function (netlify/functions/worker.mts).
 * Postgres is Netlify Database: the platform sets NETLIFY_DB_URL and applies netlify/database/migrations.
 */
import { getConnectionString, getDatabase } from '@netlify/database';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createApp } from '../api/app.js';
import { loadConfig, type Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { emailTransport, webhookPolicy } from '../deps.js';
import { createTurnstileVerifier } from '../lib/turnstile.js';
import { runOnce, type WorkerDeps } from '../worker/worker.js';

/** Set per hop or recomputed by the platform; never copied from the inner response. */
const HOP_BY_HOP = new Set(['connection', 'content-length', 'keep-alive', 'transfer-encoding']);

/**
 * Run one web Request through the Fastify app. `ip` (Netlify's `context.ip`) becomes the socket address,
 * so `req.ip` is the platform's view of the client and request headers cannot change it.
 */
export async function handle(app: FastifyInstance, req: Request, ip: string): Promise<Response> {
  const url = new URL(req.url);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const res = await app.inject({
    method: req.method as InjectOptions['method'],
    url: url.pathname + url.search,
    headers: Object.fromEntries(req.headers),
    payload: hasBody ? Buffer.from(await req.arrayBuffer()) : undefined,
    remoteAddress: ip,
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, String(v));
  }
  const empty = req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
  return new Response(empty ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers });
}

/**
 * Scheduled functions are stopped after 30 s and one delivery can take ~10 s (outbound HTTP timeouts), so
 * no delivery starts after `budgetMs`. Whatever is left goes out on the next run, a minute later.
 */
export async function drain(deps: WorkerDeps, budgetMs = 15_000): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let total = 0;
  while (Date.now() < deadline) {
    const n = await runOnce(deps, 25, deadline);
    total += n;
    if (n === 0) break;
  }
  return total;
}

interface Runtime {
  url: string;
  db: Db;
  config: Config;
  app?: Promise<FastifyInstance>;
}
let runtime: Runtime | undefined;

/** Site environment variables: `Netlify.env` inside functions, `process.env` elsewhere. */
function env(): NodeJS.ProcessEnv {
  const netlify = (globalThis as { Netlify?: { env: { toObject(): Record<string, string> } } }).Netlify;
  return netlify ? netlify.env.toObject() : process.env;
}

/** One pool per function instance, rebuilt if the platform hands out a different connection string. */
function getRuntime(): Runtime {
  const url = getConnectionString();
  if (runtime?.url !== url) {
    runtime?.db.end().catch(() => {});
    // Production unless the environment says otherwise: nothing guarantees NODE_ENV in functions, and setting
    // it site-wide would also make the build skip devDependencies. Throws on invalid configuration, e.g. a
    // deploy preview without the production-only secrets.
    const config = loadConfig({ NODE_ENV: 'production', ...env(), DATABASE_URL: url });
    // Netlify's driver choice (node-postgres or Neon serverless); both pools have the pg.Pool interface.
    const db = getDatabase({ connectionString: url }).pool as unknown as Db;
    // An idle connection dropped while the instance was frozen must not crash the next invocation.
    db.on('error', (err) => console.error(JSON.stringify({ msg: 'db pool error', error: err.message })));
    runtime = { url, db, config };
  }
  return runtime;
}

export function apiApp(): Promise<FastifyInstance> {
  const rt = getRuntime();
  rt.app ??= createApp({
    db: rt.db,
    config: rt.config,
    turnstile: createTurnstileVerifier(rt.config.turnstile),
    webhookPolicy: webhookPolicy(rt.config),
    logger: true,
  }).catch((err) => {
    rt.app = undefined;
    throw err;
  });
  return rt.app;
}

export function workerDeps(): WorkerDeps {
  const { db, config } = getRuntime();
  return {
    db,
    config,
    fetch,
    email: emailTransport(config),
    webhookPolicy: webhookPolicy(config),
    log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra, at: new Date().toISOString() })),
  };
}
