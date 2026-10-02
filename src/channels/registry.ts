import { CHANNEL_NAMES, type ChannelName } from '../config.js';
import { bluesky } from './bluesky.js';
import { linkedin, substack, truthsocial, whatsapp } from './copy-only.js';
import { email } from './email.js';
import { mastodon } from './mastodon.js';
import { rss } from './rss.js';
import { telegram } from './telegram.js';
import type { ChannelAdapter } from './types.js';
import { webhook } from './webhook.js';
import { x } from './x.js';

export const ADAPTERS: Record<ChannelName, ChannelAdapter> = {
  email,
  webhook,
  rss,
  telegram,
  bluesky,
  mastodon,
  x,
  linkedin,
  substack,
  whatsapp,
  truthsocial,
};

// Every configured channel name must have an adapter, and vice versa.
for (const n of CHANNEL_NAMES) if (ADAPTERS[n]?.name !== n) throw new Error(`adapter registry mismatch: ${n}`);
