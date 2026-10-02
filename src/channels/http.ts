import type { DeliveryResult } from './types.js';

/** Map an HTTP failure to a delivery result: 408/429/5xx and network errors are retryable. */
export function httpFailure(status: number, body: string): DeliveryResult {
  const retryable = status === 408 || status === 429 || status >= 500;
  return { ok: false, retryable, error: `HTTP ${status}: ${body.slice(0, 300)}` };
}

export function networkFailure(err: unknown): DeliveryResult {
  return {
    ok: false,
    retryable: true,
    uncertain: true,
    error: `network: ${err instanceof Error ? err.message : String(err)}`,
  };
}

export async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; json: any }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, text, json };
}
