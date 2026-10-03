# HACK-ATTACK

Public warning service for AI hacks and attacks - the hack-attack registry (hack-attack.ai).

Status: v0 subscriptions, onboarding and channel distribution built and tested locally; not deployed.
Design, decisions awaiting sign-off and unverified external facts: [`docs/PLAN.md`](docs/PLAN.md).
Deploy runbook (Fly.io + Netlify + DNS): [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Layout

- `src/api` - Fastify API (Fly.io `app` process): public feeds, subscription forms, webhook management, operator endpoints
- `src/worker` - outbox delivery, retries, digests (Fly.io `worker` process)
- `src/channels` - one `ChannelAdapter` per channel (email, webhook, rss, telegram, bluesky, mastodon, x, linkedin, substack, whatsapp, truthsocial)
- `src/domain` - events, broadcast gate, retraction, subscriptions, webhook onboarding
- `src/lib` - SSRF guard, Standard Webhooks signing, signed tokens, Turnstile, rate limiting, audit
- `src/db/migrations` - Postgres schema
- `site/` - static site for Netlify; `scripts/build-site.ts` generates feeds and event pages from the API
- `HACK-ATTACK-BRAND.md`, `hack-attack-laser-palette.*` - brand draft and colour tokens

## Develop

```sh
npm ci
cp .env.example .env            # fill in keys; never commit .env
npm run migrate
npm run dev:api & npm run dev:worker
npm run build:site              # needs the API running (or BUILD_ALLOW_EMPTY=true)
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every PR against a Postgres 16 service.
Tests need a Postgres 16 database (default `postgres://postgres@127.0.0.1:5433/hackattack_test`, override with
`TEST_DATABASE_URL`):

```sh
npm run typecheck && npm test
```

## License

MIT - see `LICENSE`.
