# v0 build plan — subscriptions, onboarding, channel distribution

Source of requirements: Don's brief, 2026-10-02 ("Hosting and licence (decided)", "Subscription and
onboarding (build in v0)", "Channel distribution (build in v0)").

## Architecture
- [x] Single TypeScript package. Fly.io runs two process groups from one image: `app` (Fastify API) and
      `worker` (outbox/digest/retry loop). Postgres holds all state, including the job queue
      (`FOR UPDATE SKIP LOCKED`), so no Redis.
- [x] Netlify serves `site/` (static HTML + generated `events.json`, `feed.xml`, `atom.xml`, `llms.txt`).
      Netlify build pulls from the API's public endpoint; no Netlify Functions.
- [x] Migrations run as Fly `release_command`.

## Data model
- [x] events (status draft|unconfirmed|confirmed|retracted, human_approved, approver, retraction)
- [x] email_subscribers + consent_records (CASL evidence, append-only)
- [x] webhook_endpoints (encrypted signing secret, failure counter, auto-disable)
- [x] outbox (idempotency key UNIQUE, dry_run, attempts, next_attempt_at, external ref, cost)
- [x] audit_log (append-only, enforced by trigger)
- [x] channel_spend (X per-post cost ledger), rate_limits, digest_queue
- [x] DB trigger: publish rows only for confirmed+approved events; retraction rows only for retracted

## Subscriptions
- [x] Email double opt-in, POST-confirm page (defeats link-scanner auto-confirm), magic-link prefs page
- [x] Unsubscribe link + RFC 8058 one-click header in every message; sender ID + postal address footer
- [x] Turnstile + Postgres-backed rate limiting on every public form
- [x] Webhooks: register -> challenge -> secret (Standard Webhooks) -> test event -> backoff -> auto-disable
- [x] SSRF guard: blocklist, resolve-then-connect with pinned lookup, no redirects, timeouts, body cap
- [x] Pull: /events.json, RSS, Atom, /llms.txt; MCP server proposed in docs/PLAN.md (not built)

## Channels
- [x] ChannelAdapter interface, modes auto|assisted|manual-queue, per-channel dry-run
- [x] Telegram, Bluesky, Mastodon, email, webhooks, RSS (Netlify build hook)
- [x] X behind flag + hard monthly cap + per-post cost ledger; refuses to run until pricing verified
- [x] LinkedIn stub (manual-queue); Substack/WhatsApp/Truth Social assisted/manual copy only
- [x] Global gate + retraction propagation to every adapter, all logged

## Verification
- [x] Unit tests: signatures (cross-checked with `standardwebhooks` package), SSRF, tokens, copy limits
- [x] Integration tests against real Postgres 16: gate, retraction, outbox idempotency, webhook lifecycle,
      X spend cap, subscription flow, rate limit
- [x] typecheck clean

## Review
(filled in at the end)

- Built: everything above. 90 tests pass (unit + integration on Postgres 16); `tsc` clean; `npm run build`
  produces `dist/` with migrations; end-to-end smoke run of the compiled API + worker + Netlify build script
  against a fresh database (create -> confirm -> approve -> broadcast -> retract -> feeds/static pages).
- Bugs found by tests and fixed: `.flycast` names not name-blocked; uuid/text parameter typing in the
  digest retraction query. Found in self-review: `.env.example` hidden by `.env.*` ignore rule; inline page
  scripts would have been blocked by the site's own CSP; raw email addresses in rate-limit keys.
- Not done: deployment (no Fly/Netlify credentials used), admin UI (operator uses the API), MCP server
  (proposal only, docs/PLAN.md section 5), live verification of third-party API details (docs/PLAN.md
  section 7).

# Deploy hack-attack.ai on Netlify only (account don@spinstatelabs.ca)

Decision (Don, 2026-10-03): run everything on Netlify (site + API function + scheduled worker + Netlify
Database) and drop Fly.io. Wait for the Netlify connector to be on don@spinstatelabs.ca before deploying;
build and verify on the branch now.

## Plan
- [x] Deps: `@netlify/database` (provisions Postgres on deploy), `@netlify/functions` (types)
- [x] `netlify/functions/api.mts`: one function on `/v1/*` + `/healthz`, wraps the existing Fastify app via
      `inject`; client IP from Netlify's `context.ip` (as the socket address), never from a request header
- [x] `netlify/functions/worker.mts`: scheduled every minute; drains the outbox under a time budget well
      inside the 30 s scheduled-function limit; hourly maintenance
- [x] `runOnce` deadline: stop starting deliveries past the deadline, hand unstarted claimed rows back
- [x] `clientIp`: drop the `Fly-Client-IP` branch (spoofable once Fly's proxy is gone)
- [x] Migrations to `netlify/database/migrations/001_init/migration.sql` (Netlify applies them before
      publishing); `migrate.ts` reads the same files for local dev and tests
- [x] `netlify.toml`: describes the Netlify-only layout, CSP `connect-src 'self'`; API URL defaults to the site origin
- [x] Remove `fly.toml`, `Dockerfile`, `.dockerignore`
- [x] Tests: adapter (method, path, query, body, headers, IP), worker deadline, spoofed IP header ignored
- [x] Verify: typecheck, full test suite, `npm run build`, bundle both functions with Netlify's bundler and
      invoke the bundles against local Postgres
- [x] Docs: `docs/DEPLOY.md` (Netlify only), `docs/PLAN.md` hosting section, README, `.env.example`
- [ ] Deploy (after the connector is on don@spinstatelabs.ca): `docs/DEPLOY.md` steps 1-6

## Review
- 96 tests pass on Postgres 16 (90 existing + 6 new); typecheck and `npm run build` clean.
- Both functions bundled with Netlify's bundler (`@netlify/zip-it-and-ship-it` 16.2.3; manifest: `api` routes
  `/v1/*` + `/healthz`, `worker` schedule `* * * * *`) and the bundles invoked directly against a fresh
  database in production mode: health, feed, consent text, admin auth (401/200), create -> confirm -> approve
  through the API, then the worker delivered the outbox row (dry-run) and the event appeared in the feed.
- Found and fixed on the way: `Fly-Client-IP` would have been trusted from any client once Fly's proxy was
  gone (rate limits and Turnstile IP spoofable); unset `NODE_ENV` on Netlify would have silently disabled the
  production checks (now defaults to production in the Netlify runtime); `node_bundler = "esbuild"` has no
  effect on these functions (Netlify uses its tracer bundler), so it is not set.
- Not verified here: a real Netlify deploy (wrong connector account), Netlify Database provisioning and its
  migration runner on `citext`, Turnstile against Cloudflare (blocked by the sandbox network), plan limits
  and pricing.
- Local DBs migrated by the old runner recorded `001_init.sql`; the runner now records `001_init`. Recreate
  any local dev database (nothing is deployed).
