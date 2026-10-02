import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { webhookPolicy } from '../deps.js';
import { createTurnstileVerifier } from '../lib/turnstile.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = await createApp({
  db,
  config,
  turnstile: createTurnstileVerifier(config.turnstile),
  webhookPolicy: webhookPolicy(config),
  logger: true,
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: config.port });
