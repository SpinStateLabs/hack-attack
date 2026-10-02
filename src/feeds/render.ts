import type { PublicEvent } from '../channels/types.js';
import type { Config } from '../config.js';

/** Pull-channel renderers. Pure functions: used by the API (live) and the Netlify build (static). */

export interface FeedSite {
  siteUrl: string;
  title: string;
  description: string;
}

export const feedSite = (config: Pick<Config, 'siteUrl'>): FeedSite => ({
  siteUrl: config.siteUrl,
  title: 'HACK-ATTACK',
  description: 'Public warning service for AI hacks and attacks. Confirmed, human-approved warnings only.',
});

const xml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

const itemTitle = (e: PublicEvent) =>
  e.status === 'retracted' ? `RETRACTED: ${e.title}` : `[${e.severity.toUpperCase()}] ${e.title}`;
const itemText = (e: PublicEvent) =>
  e.status === 'retracted' ? `Retracted: ${e.retraction_reason ?? ''}. Original summary: ${e.summary}` : e.summary;

export function renderEventsJson(site: FeedSite, events: PublicEvent[], generatedAt = new Date()): string {
  return JSON.stringify(
    {
      version: 1,
      title: site.title,
      description: site.description,
      home_page_url: site.siteUrl,
      generated_at: generatedAt.toISOString(),
      events,
    },
    null,
    2,
  );
}

export function renderRss(site: FeedSite, events: PublicEvent[], generatedAt = new Date()): string {
  const items = events
    .map(
      (e) => `    <item>
      <title>${xml(itemTitle(e))}</title>
      <link>${xml(e.url)}</link>
      <guid isPermaLink="false">${xml(e.id)}</guid>
      <pubDate>${new Date(e.published_at).toUTCString()}</pubDate>
      <description>${xml(itemText(e))}</description>
${e.categories.map((c) => `      <category>${xml(c)}</category>`).join('\n')}
    </item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(site.title)}</title>
    <link>${xml(site.siteUrl)}</link>
    <description>${xml(site.description)}</description>
    <language>en</language>
    <lastBuildDate>${generatedAt.toUTCString()}</lastBuildDate>
    <atom:link href="${xml(site.siteUrl)}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

export function renderAtom(site: FeedSite, events: PublicEvent[], generatedAt = new Date()): string {
  const updated = events.reduce((m, e) => (e.updated_at > m ? e.updated_at : m), generatedAt.toISOString());
  const entries = events
    .map(
      (e) => `  <entry>
    <id>urn:uuid:${xml(e.id)}</id>
    <title>${xml(itemTitle(e))}</title>
    <link href="${xml(e.url)}"/>
    <published>${xml(e.published_at)}</published>
    <updated>${xml(e.updated_at)}</updated>
    <summary>${xml(itemText(e))}</summary>
${e.categories.map((c) => `    <category term="${xml(c)}"/>`).join('\n')}
  </entry>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xml(site.siteUrl)}/</id>
  <title>${xml(site.title)}</title>
  <subtitle>${xml(site.description)}</subtitle>
  <link href="${xml(site.siteUrl)}"/>
  <link rel="self" href="${xml(site.siteUrl)}/atom.xml"/>
  <updated>${xml(updated)}</updated>
  <author><name>${xml(site.title)}</name></author>
${entries}
</feed>
`;
}

/** llms.txt (https://llmstxt.org/): a markdown index for language models. */
export function renderLlmsTxt(site: FeedSite, events: PublicEvent[]): string {
  const lines = [
    `# ${site.title}`,
    '',
    `> ${site.description}`,
    '',
    'Every entry below passed two gates before publication: status confirmed and explicit human approval.',
    'Retracted entries stay listed and are marked RETRACTED; treat them as withdrawn.',
    '',
    '## Machine-readable feeds',
    '',
    `- [events.json](${site.siteUrl}/events.json): all published and retracted warnings as JSON`,
    `- [RSS](${site.siteUrl}/feed.xml): RSS 2.0 feed`,
    `- [Atom](${site.siteUrl}/atom.xml): Atom feed`,
    '',
    '## Warnings',
    '',
    ...events.map((e) => `- [${itemTitle(e)}](${e.url}): ${itemText(e).replace(/\s+/g, ' ')}`),
    '',
  ];
  return lines.join('\n');
}
