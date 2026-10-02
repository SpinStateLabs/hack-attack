import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupAddress } from 'node:dns';

/**
 * SSRF-safe outbound POST for subscriber-supplied webhook URLs.
 *
 * Defences:
 * 1. URL policy: https only (http only when explicitly allowed outside production), allowed ports,
 *    no credentials in the URL, no `localhost` / `.internal` / `.local` style names.
 * 2. Address policy: IPv4 private, loopback, link-local (incl. cloud metadata 169.254.169.254), CGNAT,
 *    multicast, reserved and documentation ranges are blocked. IPv6 must be global unicast (2000::/3)
 *    and outside the special-purpose blocks inside it; IPv4-mapped IPv6 is checked as IPv4.
 * 3. Resolve-then-connect: the socket's DNS lookup is replaced by one that resolves, rejects the whole
 *    request if ANY resolved address is blocked, and hands the vetted address to the socket. The
 *    connection therefore goes to the address that was checked (no DNS-rebinding window).
 * 4. No redirects are followed (3xx is returned to the caller as a failure).
 * 5. Short connect/total timeouts and a cap on bytes read from the response.
 */

const v4Blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  v4Blocked.addSubnet(addr, prefix, 'ipv4');
}

const v6GlobalUnicast = new net.BlockList();
v6GlobalUnicast.addSubnet('2000::', 3, 'ipv6');
const v6Blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['2001::', 23], // IETF protocol assignments (incl. Teredo 2001::/32)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds arbitrary IPv4)
] as const) {
  v6Blocked.addSubnet(addr, prefix, 'ipv6');
}

/** Expand an IPv6 string to 16 bytes. Returns null if malformed. */
function ipv6Bytes(addr: string): number[] | null {
  let s = addr.split('%')[0] ?? '';
  const tail: number[] = [];
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    if (!net.isIPv4(dotted[1])) return null;
    tail.push(...dotted[1].split('.').map(Number));
    s = s.slice(0, -dotted[1].length) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string | undefined) => (h ? h.split(':') : []);
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

export function isPublicAddress(addr: string): boolean {
  if (net.isIPv4(addr)) return !v4Blocked.check(addr, 'ipv4');
  if (!net.isIPv6(addr)) return false;
  const b = ipv6Bytes(addr);
  if (!b) return false;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded IPv4.
  const zeros = b.slice(0, 10).every((x) => x === 0);
  if (zeros && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
    return isPublicAddress(b.slice(12).join('.'));
  }
  return v6GlobalUnicast.check(addr, 'ipv6') && !v6Blocked.check(addr, 'ipv6');
}

export interface OutboundPolicy {
  allowHttp: boolean;
  allowedPorts: number[];
  timeoutMs: number;
  maxResponseBytes?: number;
  /** Test seam: override address vetting. Production code never sets this. */
  isAllowedAddress?: (addr: string) => boolean;
  /** Test seam: override DNS resolution. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|flycast|localdomain|home\.arpa|in-addr\.arpa|ip6\.arpa|onion)\.?$/i;

/** Validate a URL against the static policy (no DNS). Throws SsrfError. */
export function checkUrl(raw: string, policy: Pick<OutboundPolicy, 'allowHttp' | 'allowedPorts'>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('invalid URL');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new SsrfError('URL must use https');
  }
  if (url.username || url.password) throw new SsrfError('credentials in URL are not allowed');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!policy.allowedPorts.includes(port)) throw new SsrfError(`port ${port} is not allowed`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_NAMES.test(host) || !/[.:]/.test(host)) throw new SsrfError('host is not allowed');
  if (raw.length > 2048) throw new SsrfError('URL too long');
  return url;
}

export interface OutboundResponse {
  status: number;
  body: string;
}

export async function safePost(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  policy: OutboundPolicy,
): Promise<OutboundResponse> {
  const url = checkUrl(rawUrl, policy);
  const allowed = policy.isAllowedAddress ?? isPublicAddress;
  const resolve =
    policy.resolve ?? ((hostname: string) => dns.promises.lookup(hostname, { all: true, verbatim: true }));
  const host = url.hostname.replace(/^\[|\]$/g, '');

  // IP literals bypass the socket's lookup hook, so vet them here and connect to them directly.
  let pinned: LookupAddress[] | null = null;
  if (net.isIP(host)) {
    if (!allowed(host)) throw new SsrfError(`address ${host} is not allowed`);
    pinned = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  } else {
    const addrs = await resolve(host);
    if (!addrs.length) throw new SsrfError('host did not resolve');
    const bad = addrs.find((a) => !allowed(a.address));
    if (bad) throw new SsrfError(`host resolves to a blocked address (${bad.address})`);
    pinned = addrs;
  }
  const vetted = pinned;

  // The socket uses this instead of DNS: it can only ever see the addresses vetted above.
  const lookup = (
    _hostname: string,
    options: { all?: boolean },
    cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    if (options?.all) cb(null, vetted);
    else cb(null, vetted[0]!.address, vetted[0]!.family);
  };

  const maxBytes = policy.maxResponseBytes ?? 64 * 1024;
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise<OutboundResponse>((resolvePromise, reject) => {
    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'hack-attack-webhooks/0.1', ...headers },
        lookup: lookup as never,
        agent: false,
        timeout: policy.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('close', () => {
          clearTimeout(total);
          resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', () => {});
      },
    );
    const total = setTimeout(() => req.destroy(new Error('request timed out')), policy.timeoutMs);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', (err) => {
      clearTimeout(total);
      reject(err);
    });
    req.end(body);
  });
}
