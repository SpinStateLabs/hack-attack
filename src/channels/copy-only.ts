import { longPost, shortPost } from './copy.js';
import { copyOnly, type ChannelAdapter } from './types.js';

/**
 * Channels with no official posting API we may use. They only generate paste-ready copy into the
 * operator queue; an operator posts by hand and records the resulting URL. No unofficial clients,
 * scraping or session-cookie automation, by policy.
 */
const base = {
  supportedModes: ['assisted', 'manual-queue'] as const,
  idempotent: false,
  canDeliver: false,
  missingConfig: () => [],
  deliver: copyOnly,
};

export const substack: ChannelAdapter = {
  ...base,
  name: 'substack',
  render: (event, kind) => ({
    title: kind === 'retraction' ? `Retraction: ${event.title}` : event.title,
    text: longPost(event, kind),
  }),
};

export const whatsapp: ChannelAdapter = {
  ...base,
  name: 'whatsapp',
  render: (event, kind) => {
    const text = shortPost(event, kind, { max: 1000, measure: (s) => s.length });
    // wa.me click-to-chat is WhatsApp's official share link; it opens the app with the text prefilled.
    return { text, shareUrl: `https://wa.me/?text=${encodeURIComponent(text)}` };
  },
};

export const truthsocial: ChannelAdapter = {
  ...base,
  name: 'truthsocial',
  // Character limit not verified; 500 assumed (Mastodon-derived platform). Operator checks before posting.
  render: (event, kind) => ({ text: shortPost(event, kind, { max: 500, measure: (s) => s.length }) }),
};

/**
 * LinkedIn: stub. Organisation posting needs Community Management API approval (w_organization_social),
 * assumed pending. Until approved this is a manual queue with paste-ready copy. When approval lands,
 * implement deliver() against the official Posts API and allow 'auto' in config.
 */
export const linkedin: ChannelAdapter = {
  ...base,
  name: 'linkedin',
  render: (event, kind) => ({ text: longPost(event, kind) }),
};
