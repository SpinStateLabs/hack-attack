import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { emailTransport, webhookPolicy } from '../deps.js';
import { maintenance, runOnce, type WorkerDeps } from './worker.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const deps: WorkerDeps = {
  db,
  config,
  fetch,
  email: emailTransport(config),
  webhookPolicy: webhookPolicy(config),
  log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra, at: new Date().toISOString() })),
};

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));

const live = Object.entries(config.channels)
  .filter(([, c]) => c.enabled)
  .map(([n, c]) => `${n}:${c.mode}${c.dryRun ? ':dry-run' : ''}`);
deps.log?.('worker started', { channels: live });

let lastMaintenance = 0;
while (!stopping) {
  try {
    const n = await runOnce(deps);
    if (Date.now() - lastMaintenance > 3600_000) {
      await maintenance(deps);
      lastMaintenance = Date.now();
    }
    if (n === 0) await sleep(2000);
  } catch (err) {
    deps.log?.('worker loop error', { error: err instanceof Error ? err.message : String(err) });
    await sleep(5000);
  }
}
await db.end();
