/**
 * Netlify build: pull published events from the API and write static, read-only outputs into site/.
 * No delivery logic runs here. If the API is unreachable the build FAILS, so Netlify keeps serving the
 * previous deploy instead of publishing an empty feed (set BUILD_ALLOW_EMPTY=true only for a first deploy).
 */
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PublicEvent } from '../src/channels/types.js';
import { escapeHtml } from '../src/channels/copy.js';
import { renderAtom, renderEventsJson, renderLlmsTxt, renderRss, type FeedSite } from '../src/feeds/render.js';

const SITE_DIR = join(import.meta.dirname, '..', 'site');
const siteUrl = (process.env.PUBLIC_SITE_URL ?? 'https://hack-attack.ai').replace(/\/$/, '');
const apiUrl = (process.env.PUBLIC_API_URL ?? siteUrl).replace(/\/$/, '');
const site: FeedSite = {
  siteUrl,
  title: 'HACK-ATTACK',
  description: 'Public warning service for AI hacks and attacks. Confirmed, human-approved warnings only.',
};

async function fetchEvents(): Promise<PublicEvent[]> {
  try {
    const res = await fetch(`${apiUrl}/v1/public/events`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { events: PublicEvent[] }).events;
  } catch (err) {
    if (process.env.BUILD_ALLOW_EMPTY === 'true') {
      console.warn(`API unreachable (${(err as Error).message}); building with no events`);
      return [];
    }
    throw new Error(`Cannot fetch events from ${apiUrl}: ${(err as Error).message}. Failing build to keep the last deploy.`);
  }
}

function eventPage(e: PublicEvent): string {
  const retracted = e.status === 'retracted';
  const sources = e.sources.map((s) => `<li><a href="${escapeHtml(s.url)}" rel="nofollow noopener">${escapeHtml(s.title)}</a></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(e.title)} · HACK-ATTACK</title>
<link rel="stylesheet" href="/assets/palette.css"><link rel="stylesheet" href="/assets/style.css"></head>
<body><main><p><a href="/">HACK-ATTACK</a></p>
${retracted ? `<section><strong>RETRACTED</strong> ${escapeHtml(e.retracted_at ?? '')}: ${escapeHtml(e.retraction_reason ?? '')}</section>` : ''}
<h1 class="${retracted ? 'retracted' : ''}">${escapeHtml(e.title)}</h1>
<p><span class="sev sev-${escapeHtml(e.severity)}">${escapeHtml(e.severity)}</span> · ${e.categories.map(escapeHtml).join(', ')} · published ${escapeHtml(e.published_at)}</p>
<p>${escapeHtml(e.summary)}</p>
${sources ? `<h2>Sources</h2><ul>${sources}</ul>` : ''}
</main></body></html>`;
}

// Single source of truth for the palette is the repo root token file.
await copyFile(join(SITE_DIR, '..', 'hack-attack-laser-palette.css'), join(SITE_DIR, 'assets', 'palette.css'));

const events = await fetchEvents();
await writeFile(join(SITE_DIR, 'events.json'), renderEventsJson(site, events));
await writeFile(join(SITE_DIR, 'feed.xml'), renderRss(site, events));
await writeFile(join(SITE_DIR, 'atom.xml'), renderAtom(site, events));
await writeFile(join(SITE_DIR, 'llms.txt'), renderLlmsTxt(site, events));
await writeFile(
  join(SITE_DIR, 'config.js'),
  `window.HACK_ATTACK = ${JSON.stringify({ apiUrl, turnstileSiteKey: process.env.TURNSTILE_SITE_KEY ?? '' })};\n`,
);
await rm(join(SITE_DIR, 'events'), { recursive: true, force: true });
for (const e of events) {
  const dir = join(SITE_DIR, 'events', e.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), eventPage(e));
}
console.log(`built site: ${events.length} events`);
