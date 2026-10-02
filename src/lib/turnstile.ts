/** Cloudflare Turnstile server-side verification. */
export type TurnstileVerifier = (token: string | undefined, remoteIp: string | undefined) => Promise<boolean>;

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function createTurnstileVerifier(
  opts: { secretKey?: string; bypass: boolean },
  fetchImpl: typeof fetch = fetch,
): TurnstileVerifier {
  return async (token, remoteIp) => {
    if (opts.bypass) return true;
    if (!opts.secretKey || !token || token.length > 2048) return false;
    const form = new URLSearchParams({ secret: opts.secretKey, response: token });
    if (remoteIp) form.set('remoteip', remoteIp);
    try {
      const res = await fetchImpl(SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const data = (await res.json()) as { success?: boolean };
      return data.success === true;
    } catch {
      return false; // fail closed
    }
  };
}
