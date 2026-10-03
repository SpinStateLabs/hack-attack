import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { handle } from '../../src/platform/netlify.js';

function echoApp() {
  const app = Fastify();
  app.all('/echo', async (req, reply) => {
    reply.header('set-cookie', ['a=1', 'b=2']).header('x-custom', 'yes');
    return { method: req.method, url: req.url, ip: req.ip, body: req.body ?? null, ua: req.headers['user-agent'] ?? null };
  });
  app.get('/empty', async (_req, reply) => reply.code(204).send());
  return app;
}

describe('Netlify function adapter', () => {
  it('forwards method, path, query, headers and body, and returns status, headers and body', async () => {
    const res = await handle(
      echoApp(),
      new Request('https://hack-attack.ai/echo?a=1&b=two', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'test-agent' },
        body: JSON.stringify({ hello: 'world' }),
      }),
      '203.0.113.7',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-custom')).toBe('yes');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await res.json()).toEqual({
      method: 'POST',
      url: '/echo?a=1&b=two',
      ip: '203.0.113.7',
      body: { hello: 'world' },
      ua: 'test-agent',
    });
  });

  it("uses the platform's client IP and ignores client-supplied IP headers", async () => {
    const spoofed = { 'x-forwarded-for': '6.6.6.6', 'fly-client-ip': '6.6.6.6', 'x-nf-client-connection-ip': '6.6.6.6', 'x-real-ip': '6.6.6.6' };
    const res = await handle(echoApp(), new Request('https://hack-attack.ai/echo', { headers: spoofed }), '198.51.100.20');
    expect((await res.json()).ip).toBe('198.51.100.20');
  });

  it('returns no body for 204 and HEAD', async () => {
    const empty = await handle(echoApp(), new Request('https://hack-attack.ai/empty'), '198.51.100.1');
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
    const head = await handle(echoApp(), new Request('https://hack-attack.ai/echo', { method: 'HEAD' }), '198.51.100.1');
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
  });
});
