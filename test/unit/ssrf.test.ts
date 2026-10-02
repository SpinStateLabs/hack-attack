import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkUrl, isPublicAddress, safePost, SsrfError, type OutboundPolicy } from '../../src/lib/ssrf.js';

describe('address policy', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fdaa:0:1::3', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2001:db8::1',
  ])('blocks %s', (addr) => expect(isPublicAddress(addr)).toBe(false));

  it.each(['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (addr) =>
    expect(isPublicAddress(addr)).toBe(true),
  );
});

describe('URL policy', () => {
  const p = { allowHttp: false, allowedPorts: [443] };
  it.each([
    ['http://example.com/hook', 'https'],
    ['https://user:pw@example.com/', 'credentials'],
    ['https://example.com:22/', 'port'],
    ['https://localhost/', 'host'],
    ['https://foo.internal/', 'host'],
    ['https://my-app.flycast/', 'host'],
    ['https://intranet/', 'host'],
    ['ftp://example.com/', 'https'],
  ])('rejects %s', (url, why) => {
    expect(() => checkUrl(url, p)).toThrow(SsrfError);
    expect(() => checkUrl(url, p)).toThrow(new RegExp(why === 'host' ? 'host' : why));
  });
  it('accepts a normal https URL', () => expect(checkUrl('https://hooks.example.com/x', p).hostname).toBe('hooks.example.com'));
});

describe('safePost', () => {
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 3000);
      } else if (req.url === '/big') {
        res.end('x'.repeat(200_000));
      } else {
        res.end('ok');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const strict = (): OutboundPolicy => ({ allowHttp: true, allowedPorts: [port], timeoutMs: 1000 });
  // Test-only policy: treat loopback as "public" so we can observe real requests.
  const permissive = (over: Partial<OutboundPolicy> = {}): OutboundPolicy => ({
    ...strict(),
    isAllowedAddress: (a) => a === '127.0.0.1',
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    ...over,
  });

  it('blocks a loopback IP literal under the default policy, before any connection', async () => {
    const before = hits.length;
    await expect(safePost(`http://127.0.0.1:${port}/`, '{}', {}, strict())).rejects.toThrow(SsrfError);
    expect(hits.length).toBe(before);
  });

  it('blocks a hostname that resolves to a private address (resolve-then-connect)', async () => {
    const policy = { ...strict(), resolve: async () => [{ address: '127.0.0.1', family: 4 }] };
    await expect(safePost(`http://hooks.example.com:${port}/`, '{}', {}, policy)).rejects.toThrow(/blocked address/);
  });

  it('blocks when ANY resolved address is private (mixed DNS answers)', async () => {
    const policy = permissive({
      isAllowedAddress: (a) => a !== '10.0.0.5',
      resolve: async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    });
    await expect(safePost(`http://hooks.example.com:${port}/`, '{}', {}, policy)).rejects.toThrow(/10\.0\.0\.5/);
  });

  it('connects to the vetted address, not a fresh DNS answer', async () => {
    // "hooks.example.com" does not resolve to 127.0.0.1 in real DNS; reaching the server proves the pin.
    const res = await safePost(`http://hooks.example.com:${port}/pinned`, '{}', {}, permissive());
    expect(res.status).toBe(200);
    expect(hits).toContain('/pinned');
  });

  it('does not follow redirects', async () => {
    const res = await safePost(`http://hooks.example.com:${port}/redirect`, '{}', {}, permissive());
    expect(res.status).toBe(302);
  });

  it('times out slow endpoints', async () => {
    await expect(safePost(`http://hooks.example.com:${port}/slow`, '{}', {}, permissive({ timeoutMs: 300 }))).rejects.toThrow(
      /timed out/,
    );
  });

  it('caps the response body size', async () => {
    const res = await safePost(`http://hooks.example.com:${port}/big`, '{}', {}, permissive({ maxResponseBytes: 1024 }));
    expect(res.body.length).toBeLessThanOrEqual(1024);
  });
});
