import type { Config, Context } from '@netlify/functions';
import { apiApp, handle } from '../../src/platform/netlify.js';

// The whole API (src/api/app.ts): public read, subscriptions, webhooks, operator endpoints.
export default async (req: Request, context: Context) => handle(await apiApp(), req, context.ip);

export const config: Config = {
  path: ['/v1/*', '/healthz'],
};
