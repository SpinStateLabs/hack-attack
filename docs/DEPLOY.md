# Deploy runbook: hack-attack.ai on Netlify

Owner account: **don@spinstatelabs.ca**. Check the signed-in identity before creating anything. A project
created under another account has to be rebuilt there, and the domain and database go with it.

Everything runs in one Netlify project:

| Piece | Where | Notes |
|---|---|---|
| Static site, `events.json`, `feed.xml`, `atom.xml`, `llms.txt`, event pages | `site/`, built by `npm run build:site` | The build fetches events from the live API and **fails if it is unreachable** (keeps the last deploy). |
| API | Function `api` on `/v1/*` and `/healthz` (`netlify/functions/api.mts`) | The Fastify app from `src/api/app.ts`; same origin as the site. |
| Worker | Scheduled function `worker`, every minute (`netlify/functions/worker.mts`) | Runs on published production deploys only. |
| Postgres | Netlify Database | Provisioned because `@netlify/database` is a dependency. `netlify/database/migrations` is applied before each production deploy is published, and a failing migration blocks the publish. |

## 0. Prerequisites

- [ ] Netlify account for don@spinstatelabs.ca, with its GitHub connection able to see `SpinStateLabs/hack-attack`.
- [ ] Cloudflare Turnstile widget (Cloudflare dashboard → Turnstile → Add widget) for hostnames `hack-attack.ai`
      and `www.hack-attack.ai`. You get a **site key** (public) and a **secret key**. The API refuses to start
      without the secret key.
- [ ] Access to DNS for `hack-attack.ai`. As of 2026-10-03 the apex resolves to `3.33.130.190` / `15.197.148.33`,
      which look like a registrar parking page.
- [ ] Not yet checked: whether the Netlify plan covers Netlify Database and the scheduled function's invocation
      volume (about 43,200 runs a month), and what it costs.

## 1. Create the project, previews off

1. **Add new project → Import an existing project → GitHub → `SpinStateLabs/hack-attack`**, production branch
   `main`. Build settings come from `netlify.toml`; leave the detected values.
2. Before the first deploy, turn **Deploy Previews off**: Project configuration → Build & deploy → Continuous
   deployment → Deploy Previews → *Don't deploy pull requests*. Each deploy preview gets its own database branch
   **copied from production**, and production holds subscriber emails, CASL consent records with IP addresses,
   and encrypted webhook secrets. Branch deploys stay off too (the default).

## 2. Environment variables

Project configuration → Environment variables. Mark secrets as secret. Set them for the **Production** context
only, so anything that is not a production deploy cannot read them, and the API refuses to start there.

| Key | Value | Scopes |
|---|---|---|
| `PUBLIC_SITE_URL` | `https://hack-attack.ai` | Builds, Functions |
| `PUBLIC_API_URL` | `https://hack-attack.ai` (the API shares the site's origin) | Builds, Functions |
| `TURNSTILE_SITE_KEY` | Turnstile site key | Builds |
| `TURNSTILE_SECRET_KEY` | Turnstile secret key | Functions |
| `TOKEN_SIGNING_KEY` | `openssl rand -base64 32` | Functions |
| `SECRET_ENCRYPTION_KEY` | `openssl rand -base64 32`. Back it up: losing or changing it makes stored webhook secrets unreadable. | Functions |
| `ADMIN_TOKENS` | `don:<sha256 hex of your admin token>` (see below) | Functions |
| `BUILD_ALLOW_EMPTY` | `true` until `https://hack-attack.ai/healthz` answers (step 6); then delete | Builds |

```sh
ADMIN_TOKEN=$(openssl rand -base64 32)            # keep in your password manager; it is the operator credential
printf %s "$ADMIN_TOKEN" | shasum -a 256          # Linux: sha256sum
```

Do not set `NODE_ENV`. The functions default to production (`src/platform/netlify.ts`), and `NODE_ENV=production`
in the build would make `npm` skip the devDependencies that `build:site` needs. Do not set `DATABASE_URL`
either; Netlify Database provides `NETLIFY_DB_URL`.

## 3. First deploy and checks

Trigger the deploy (Deploys → Trigger deploy). In the deploy log, check that the database was provisioned and
the migration `001_init` was applied, then:

```sh
H=https://<project>.netlify.app
curl -fsS $H/healthz                              # {"ok":true}
curl -fsS $H/v1/public/events                     # {"version":1,...,"events":[]}
curl -fsS $H/v1/admin/queue -H "Authorization: Bearer $ADMIN_TOKEN"   # {"items":[]}
```

Keep `BUILD_ALLOW_EMPTY` for now. The build fetches events from `PUBLIC_API_URL` (`https://hack-attack.ai`),
which still serves the parking page until step 5.

Logs → Functions → `worker` should show a run every minute without errors. It logs `worker run` only when it
delivered something.

## 4. Build hook

The worker rebuilds the static feeds and event pages after each broadcast or retraction. Project configuration →
Build & deploy → Build hooks → Add build hook (`api-events`, branch `main`). Store the URL as
`NETLIFY_BUILD_HOOK_URL` (Functions scope, Production context, secret), then redeploy. Functions only pick up
environment changes on a new deploy.

## 5. Domain

Domain management → Add a domain → `hack-attack.ai`, kept as the primary domain, with `www` redirecting to it.
DNS records (remove the parking A records first):

| Name | Type | Value |
|---|---|---|
| `hack-attack.ai` | ALIAS/ANAME/flattened CNAME | `apex-loadbalancer.netlify.com` (if supported), else **A** `75.2.60.5` |
| `www` | CNAME | `<project>.netlify.app` |

These are Netlify's published external-DNS targets (checked 2026-10-03). If the domain screen in Netlify shows
different values, use those. The alternative is to switch the registrar's nameservers to Netlify DNS. No `api`
subdomain is needed any more. Netlify issues the TLS certificate once DNS resolves.

## 6. Switch the build to the live API, then verify

Once `curl -fsS https://hack-attack.ai/healthz` returns `{"ok":true}`, **delete `BUILD_ALLOW_EMPTY`** and deploy
again. From then on a build that cannot reach the API fails and Netlify keeps serving the previous deploy,
instead of publishing an empty feed.

```sh
curl -fsS https://hack-attack.ai/healthz
curl -fsSI https://hack-attack.ai/ | grep -i content-security-policy     # connect-src 'self'
curl -fsS https://hack-attack.ai/events.json | head
```

In a browser, load `https://hack-attack.ai`. The Turnstile widget should render, the console should show no CSP
errors, and the consent wording should load. If it stays on "Loading consent wording…", the API or CSP is wrong.

## Limits of this setup

From the Netlify documentation returned by the connector, and the constants in `@netlify/functions` 6.0.2:

- **Worker latency and throughput.** Scheduled functions run at most once a minute and stop after 30 s. The worker
  starts no delivery after 15 s (`drain` in `src/platform/netlify.ts`), so a warning goes out within about a
  minute of approval, and deliveries run one at a time. A large email or webhook fan-out takes several runs. If
  that gets too slow, move the drain into a background function (15-minute limit).
- **Interrupted deliveries.** If a run is killed mid-delivery, the row's lease expires after 120 s. Email,
  webhook, RSS and Mastodon rows are then retried. Telegram, Bluesky and X rows go to `needs_review` for the
  operator, to avoid duplicate public posts.
- **API requests** must finish within 30 s. The slowest one is webhook registration: an outbound challenge with
  a 5 s timeout.
- **Client IP** comes from Netlify's `context.ip`, never from request headers (`src/platform/netlify.ts`).

## Email (before announcing the subscribe form)

Every channel starts in **dry-run**. Sign-ups are recorded, but no confirmation email is sent. Going live needs
the provider decision (`docs/PLAN.md` §6.1), then these Functions variables (Production) and a redeploy:

| Key | Value |
|---|---|
| `SMTP_URL` | provider's SMTP URL, with `?connectionTimeout=10000&greetingTimeout=10000&socketTimeout=10000` appended so a stalled server cannot use up a worker run (nodemailer's defaults are minutes) |
| `EMAIL_FROM`, `SENDER_POSTAL_ADDRESS`, `SENDER_CONTACT_EMAIL` | CASL sender identification |
| `CHANNEL_EMAIL_DRY_RUN` | `false` |

The API refuses to start with live email and missing CASL fields (`src/config.ts`). Get a legal review of the
CASL wording first (`docs/PLAN.md` §7).
