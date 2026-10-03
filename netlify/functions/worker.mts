import type { Config } from '@netlify/functions';
import { drain, workerDeps } from '../../src/platform/netlify.js';
import { maintenance } from '../../src/worker/worker.js';

// Outbox delivery, retries and digests (src/worker/worker.ts). Runs on published deploys only.
export default async () => {
  const deps = workerDeps();
  if (new Date().getUTCMinutes() === 0) await maintenance(deps);
  const processed = await drain(deps);
  if (processed) deps.log?.('worker run', { processed });
};

export const config: Config = {
  schedule: '* * * * *',
};
