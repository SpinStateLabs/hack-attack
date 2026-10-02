import type { PublicEvent } from './types.js';

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export const graphemeLength = (s: string) => [...segmenter.segment(s)].length;

/** Truncate to at most `max` units as measured by `measure`, adding an ellipsis. Grapheme-safe. */
export function truncate(s: string, max: number, measure: (s: string) => number = graphemeLength): string {
  if (measure(s) <= max) return s;
  const parts = [...segmenter.segment(s)].map((x) => x.segment);
  let out = '';
  for (const p of parts) {
    if (measure(out + p + '…') > max) break;
    out += p;
  }
  return out.trimEnd() + '…';
}

export const severityLabel = (s: string) => s.toUpperCase();

/**
 * Standard short-form post: "[HIGH] Title\n\nSummary\n\nURL", with the summary truncated to fit.
 * `urlWeight` lets platforms that shorten links (X, Mastodon) count a URL as a fixed length.
 */
export function shortPost(
  event: PublicEvent,
  kind: 'publish' | 'retraction',
  opts: { max: number; includeUrl?: boolean; urlWeight?: number; measure?: (s: string) => number },
): string {
  const measure = opts.measure ?? graphemeLength;
  const includeUrl = opts.includeUrl ?? true;
  const head =
    kind === 'retraction'
      ? `RETRACTED: ${event.title}`
      : `[${severityLabel(event.severity)}] ${event.title}`;
  const body = kind === 'retraction' ? `Reason: ${event.retraction_reason ?? 'see link'}` : event.summary;
  const tail = includeUrl ? `\n\n${event.url}` : '';
  const tailCost = includeUrl ? 2 + (opts.urlWeight ?? measure(event.url)) : 0;
  const headText = truncate(head, opts.max - tailCost, measure);
  const room = opts.max - tailCost - measure(headText) - 2;
  const bodyText = room > 10 ? `\n\n${truncate(body, room, measure)}` : '';
  return `${headText}${bodyText}${tail}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Long-form paste-ready copy (Substack, LinkedIn). Plain text with a sources list. */
export function longPost(event: PublicEvent, kind: 'publish' | 'retraction'): string {
  if (kind === 'retraction') {
    return [
      `RETRACTION: ${event.title}`,
      '',
      `We have retracted this warning. Reason: ${event.retraction_reason ?? 'see link'}`,
      '',
      `Details: ${event.url}`,
    ].join('\n');
  }
  const lines = [`[${severityLabel(event.severity)}] ${event.title}`, '', event.summary, ''];
  if (event.sources.length) {
    lines.push('Sources:');
    for (const s of event.sources) lines.push(`- ${s.title}: ${s.url}`);
    lines.push('');
  }
  lines.push(`Full entry: ${event.url}`);
  return lines.join('\n');
}
