# HACK-ATTACK v0: subscriptions, onboarding and channel distribution

Status: built and tested locally (Postgres 16). Not deployed. Rev 2026-10-02.

## 1. Hosting split (decided)

| Concern | Where | Notes |
|---|---|---|
| Static site, `events.json`, `feed.xml`, `atom.xml`, `llms.txt`, event pages | Netlify | Built by `scripts/build-site.ts` from the API's public endpoint. No Netlify Functions. |
| API (`src/api`) | Fly.io process `app` | Fastify. Public read, subscription forms, webhook management, operator endpoints. |
| Worker (`src/worker`) | Fly.io process `worker` | Delivers the outbox, retries, digests, maintenance. |
| State, job queue, audit | Fly Postgres (`DATABASE_URL`) | Queue is the `outbox` table (`FOR UPDATE SKIP LOCKED`); no Redis. |
| Agents | Fly.io (future) | May create drafts and set status. Cannot approve: approval needs an operator token. |

Migrations run as the Fly `release_command`. Secrets only through `fly secrets set` / Netlify UI
(`.env.example` lists every variable; nothing secret is in the repo).

## 2. Broadcast gate and retraction

- Gate: an event broadcasts only when `status = confirmed AND human_approved = true`. Enforced three times:
  in `domain/events.ts` (`passesGate`), by a Postgres trigger on `outbox` insert, and again by the worker
  at send time (it cancels the item if the event no longer passes).
- Approval is bound to a version: editing an event clears approval; `approve` must name the version reviewed.
- Broadcast events cannot be edited; the only path is retraction.
- Retraction: unsent items are cancelled; every item that went out (or may have) gets a retraction item on
  the same channel and recipient, threaded to the original post (Telegram reply, Bluesky reply, Mastodon
  `in_reply_to_id`, X reply, `event.retracted` webhook, retraction email, feed rebuild). Copy-only channels
  get retraction copy in the operator queue. Retractions keep the original's dry-run flag and ignore the
  channel `enabled` flag. A per-channel summary, including "no prior delivery", goes to the audit log.

## 3. Channels

One `ChannelAdapter` interface (`src/channels/types.ts`). Modes: `auto` (worker posts), `assisted` (copy in
the operator queue; operator edits and releases to the API, or posts by hand), `manual-queue` (copy only;
operator posts and records the URL). Every channel has its own dry-run flag; **dry-run is the default for
all channels** and production must opt each one out.

| Channel | v0 | Default mode | Notes |
|---|---|---|---|
| Email | built | auto | Double opt-in, magic-link prefs, digest, RFC 8058 one-click, CASL footer. SMTP relay (provider not chosen). |
| Webhooks | built | auto | Standard Webhooks signatures, challenge, backoff, auto-disable, SSRF guard. |
| RSS/Atom/JSON/llms.txt | built | auto | Live from the API; "delivery" = Netlify build hook. |
| Telegram | built | auto | Bot API `sendMessage` to a channel. |
| Bluesky | built | auto | AT Protocol `createRecord`, app password, link facets. |
| Mastodon | built | auto | `POST /api/v1/statuses` with `Idempotency-Key`. |
| X | built, flagged off | auto | `X_ENABLED`, `X_PRICING_VERIFIED_ON`, monthly cap ≤ $25 ceiling in code, per-post cost ledger. |
| LinkedIn | stub | manual-queue | Community Management API approval assumed pending. No scraping/cookies. |
| Substack | copy only | assisted | Paste-ready long-form copy. |
| WhatsApp | copy only | assisted | Copy plus official `wa.me` share link. |
| Truth Social | copy only | manual-queue | Character limit unverified (500 assumed). |

Duplicate-post safety: Telegram, Bluesky and X are not idempotent. If a delivery's outcome is unknown
(timeout, crash mid-call) the item goes to `needs_review` instead of being retried.

X spend: cost is reserved in `channel_spend` under an advisory lock **before** the API call, so concurrent
workers cannot overshoot the cap, and a post whose response was lost is still counted. X is never retried
automatically. `GET /v1/admin/spend/x` shows month-to-date spend.

## 4. Subscriptions

- **Email**: `POST /v1/subscriptions/email` (Turnstile, consent checkbox, rate limits per IP and per address)
  → confirmation email → `confirm.html` button POSTs the token (a button, not a GET link, so mail scanners
  cannot confirm). Responses never reveal whether an address exists. Tokens are HMAC-signed, carried in the
  URL fragment (never reaches server logs), and revocable via a per-subscriber epoch.
- **CASL evidence**: `consent_records` (append-only, trigger-enforced) stores the exact consent wording and
  version shown, method, timestamp, IP and user agent for request, confirmation, preference change and
  withdrawal. Every message carries sender name, postal address, contact email, a manage link and an
  unsubscribe link. Unsubscribe links never expire, work after re-subscription, and take effect immediately.
  Production refuses to start with live email unless the sender fields are set.
- **Webhooks**: register → challenge (must echo) → secret (`whsec_`, encrypted at rest with AES-256-GCM) and
  a management token (stored hashed), each shown once → signed test event. Retries at ~5 s, 5 m, 30 m, 2 h,
  5 h, 10 h, 10 h. Endpoint disabled after `WEBHOOK_DISABLE_AFTER_FAILURES` (default 5) deliveries in a row
  exhaust retries, or immediately if its DNS starts pointing at a blocked address.
- **SSRF guard** (`src/lib/ssrf.ts`): https only, port allow-list, no URL credentials, blocked names
  (`localhost`, `.internal`, `.flycast`, …), blocked ranges (RFC 1918, loopback, link-local incl.
  169.254.169.254, CGNAT, multicast, reserved, documentation, ULA incl. Fly's `fdaa::/16`, IPv4-mapped and
  NAT64 forms), resolve-then-connect with the vetted address pinned into the socket's lookup, no redirects,
  5 s timeout, 64 KB response cap.
- **Pull**: `/events.json`, `/feed.xml`, `/atom.xml`, `/llms.txt`.

## 5. Proposal (not built): read-only MCP server

- Separate Fly process `mcp`, Streamable HTTP transport, no auth, rate-limited per IP.
- Reads only the public projection (`listPublicEvents`); no access to subscribers, outbox or audit tables
  (use a Postgres role with `SELECT` on `events` only, or call the public API).
- Tools: `list_events(since?, severity_min?, category?, include_retracted=true)`, `get_event(slug)`,
  `search_events(query)`. Resources: `hack-attack://events/{slug}`. Every result includes `status` so a
  retracted warning is never presented as current.
- Effort: about one day with the official TypeScript MCP SDK. Risk: prompt-injection payloads inside event
  text reach downstream agents; mitigate by returning event text as data fields, never as instructions.

## 6. Decisions I made that need your sign-off

1. **Email provider**: generic SMTP (`SMTP_URL`). Any of SES, Postmark, Resend works. Pick one.
2. **Postal address and contact email** for the CASL footer: required before email goes live.
3. **Category taxonomy** (`src/config.ts` `CATEGORIES`): placeholder list.
4. **Default severity threshold**: `high` for new subscribers and webhooks.
5. **Unsubscribe is not behind Turnstile.** The brief says Turnstile on all public forms; I exempted
   unsubscribe (page and RFC 8058 one-click) because a bot check there conflicts with one-click unsubscribe
   and makes withdrawal harder. It is still rate-limited.
6. **X hard ceiling** `X_HARD_MONTHLY_CEILING_USD = 25` in code; configured default cap $10; URL omitted
   from X posts by default (cheaper tier per the brief's figures).
7. **Webhook secret rotation** is immediate (no overlap window).
8. **Retraction emails are not sent to people who have since unsubscribed.**
9. **Fly app name and region** (`hack-attack-api`, `yyz`).

## 7. Unverified external facts

Not checked against live documentation in this session; verify before enabling each channel:

- X API pricing ($0.015 / $0.20 per post, from the brief) and the `POST /2/tweets` response shape.
- LinkedIn Community Management API scope (`w_organization_social`) and approval status.
- Telegram `reply_parameters` / `link_preview_options` field names (Bot API 7.x).
- Bluesky session lifetime (cached 30 min here) and `createSession` rate limits.
- Mastodon 500-character default and 23-character URL weighting (instance-dependent).
- Truth Social character limit.
- CASL specifics (sender identification, 10-business-day unsubscribe window, 60-day link validity): built to
  the stricter reading; get a legal review before launch.

## 8. Operator runbook (v0, API only; no admin UI yet)

```sh
A="Authorization: Bearer $ADMIN_TOKEN"; J="content-type: application/json"; API=https://api.hack-attack.ai
curl -XPOST $API/v1/admin/events -H "$A" -H "$J" -d '{"slug":"...","title":"...","summary":"...","severity":"high","categories":["jailbreak"]}'
curl -XPOST $API/v1/admin/events/$ID/status  -H "$A" -H "$J" -d '{"status":"unconfirmed"}'
curl -XPOST $API/v1/admin/events/$ID/status  -H "$A" -H "$J" -d '{"status":"confirmed"}'
curl -XPOST $API/v1/admin/events/$ID/approve -H "$A" -H "$J" -d '{"version":1}'      # broadcasts
curl        $API/v1/admin/queue -H "$A"                                               # assisted / manual items
curl -XPOST $API/v1/admin/outbox/$ITEM/release     -H "$A" -H "$J" -d '{"text":"edited copy"}'
curl -XPOST $API/v1/admin/outbox/$ITEM/mark-posted -H "$A" -H "$J" -d '{"url":"https://..."}'
curl -XPOST $API/v1/admin/events/$ID/retract -H "$A" -H "$J" -d '{"reason":"..."}'
curl        "$API/v1/admin/audit?entity_id=$ID" -H "$A"
```
