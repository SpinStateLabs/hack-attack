import { SEVERITIES, type Severity } from '../config.js';

export const severityRank = (s: string) => SEVERITIES.indexOf(s as Severity);

/** True when an event matches a subscriber's category filter (empty = all) and severity threshold. */
export function matchesFilter(
  event: { severity: string; categories: string[] },
  filter: { categories: string[]; min_severity: string },
): boolean {
  if (severityRank(event.severity) < severityRank(filter.min_severity)) return false;
  if (!filter.categories.length) return true;
  return event.categories.some((c) => filter.categories.includes(c));
}
