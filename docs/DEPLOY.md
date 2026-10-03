# Deploy runbook: hack-attack.ai on Fly.io + Netlify

Owner account for every service below: **don@spinstatelabs.ca**. Check the signed-in identity before each
step that creates something; a resource created under another account has to be transferred or rebuilt.

Target layout:

| Host | Served by | Notes |
|---|---|---|
| `hack-attack.ai`, `www.hack-attack.ai` | Netlify | Static site + feeds, built from this repo (`netlify.toml`) |
| `api.hack-attack.ai` | Fly.io app `hack-attack-api`, process `app` | Fastify API, `/healthz` |
| (no public host) | Fly.io app `hack-attack-api`, process `worker` | Outbox delivery, digests |
| (private) | Fly Managed Postgres | `DATABASE_URL` set by `fly mpg attach` |

Order matters: the Netlify build fetches events from the API and **fails if the API is unreachable**
(`scripts/build-site.ts`), so Fly goes first.

## 0. Prerequisites

- [ ] `flyctl` installed; `fly auth login` in the browser as don@spinstatelabs.ca; `fly auth whoami` prints that address.
- [ ] Netlify account for don@spinstatelabs.ca, with its GitHub connection able to see `SpinStateLabs/hack-attack`.
- [ ] Cloudflare Turnstile widget created (Cloudflare dashboard → Turnstile → Add widget), hostname
      `hack-attack.ai` (add `www.hack-attack.ai` too). You get a **site key** (public, Netlify) and a
      **secret key** (Fly secret). The API refuses to start in production without the secret key.
- [ ] Access to the DNS for `hack-attack.ai` (registrar or DNS host). As of 2026-10-03 the apex resolves to
      `3.33.130.190` / `15.197.148.33`, which look like a registrar parking page; those records get replaced.
- [ ] Decisions from `docs/PLAN.md` section 6 that block launch: app name and region (item 9, defaults below),
      email provider and CASL postal address (items 1-2; see "Email" at the end).

## 1. Fly.io: app, database, secrets, deploy

```sh
fly orgs list                                   # pick the Spin State Labs org slug -> $ORG
fly apps create hack-attack-api --org "$ORG"    # app names are global; if taken, change `app` in fly.toml

# Managed Postgres. yyz (Toronto) is listed as an MPG region; pick the smallest plan that fits.
fly mpg create --name hack-attack-db --org "$ORG" --region yyz
fly mpg list                                    # note the cluster ID
fly mpg attach <cluster-id> -a hack-attack-api  # sets the DATABASE_URL secret (pooled, via PgBouncer)
```

The code is compatible with PgBouncer's pooled endpoint: it only takes transaction-scoped advisory locks
(`pg_advisory_xact_lock`) and uses no LISTEN/NOTIFY or named prepared statements.

Generate and stage the remaining secrets (`--stage` = no restart; the first deploy picks them up):

```sh
ADMIN_TOKEN=$(openssl rand -base64 32)          # store in your password manager; it is the operator credential
HASH=$(printf %s "$ADMIN_TOKEN" | shasum -a 256 | cut -d' ' -f1)   # Linux: sha256sum

fly secrets set --stage -a hack-attack-api \
  TOKEN_SIGNING_KEY="$(openssl rand -base64 32)" \
  SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  ADMIN_TOKENS="don:$HASH" \
  TURNSTILE_SECRET_KEY="<turnstile secret key>"
```

`SECRET_ENCRYPTION_KEY` encrypts webhook signing secrets at rest. Back it up; losing or rotating it makes
the stored secrets unreadable.

Deploy from the repo root (Fly builds the `Dockerfile` remotely; no local Docker needed):

```sh
fly deploy -a hack-attack-api                   # release_command runs migrations before machines start
fly scale show -a hack-attack-api               # expect app + worker; reduce with `fly scale count app=1 worker=1` if wanted
curl -fsS https://hack-attack-api.fly.dev/healthz        # {"ok":true}
curl -fsS https://hack-attack-api.fly.dev/v1/public/events
fly logs -a hack-attack-api                     # worker logs "worker started" with every channel in dry-run
```

Two worker machines are safe (the outbox is claimed with `FOR UPDATE SKIP LOCKED`), just not needed for v0.

## 2. Netlify: site

1. In the don@spinstatelabs.ca team: **Add new project → Import an existing project → GitHub →
   `SpinStateLabs/hack-attack`**, production branch `main`. Build settings come from `netlify.toml`
   (`npm run build:site`, publish `site`, Node 22); leave the UI fields as detected.
2. **Project configuration → Environment variables** (scope: Builds):

   | Key | Value |
   |---|---|
   | `PUBLIC_API_URL` | `https://api.hack-attack.ai` until DNS is live, the build can use `https://hack-attack-api.fly.dev` |
   | `PUBLIC_SITE_URL` | `https://hack-attack.ai` |
   | `TURNSTILE_SITE_KEY` | Turnstile site key |

   Do not set `BUILD_ALLOW_EMPTY` unless the API is down on the very first build; left on, it would publish
   an empty feed whenever the API is unreachable.
3. Trigger a deploy and check `https://<project>.netlify.app/events.json` and `/feed.xml`.
4. **Project configuration → Build & deploy → Build hooks → Add build hook** (name `api-events`, branch
   `main`). Give the URL to the API so it can rebuild feeds after each broadcast or retraction:

   ```sh
   fly secrets set -a hack-attack-api NETLIFY_BUILD_HOOK_URL="<build hook URL>"
   ```

The subscribe forms will not work on the `netlify.app` hostname. The site's CSP only allows
`connect-src https://api.hack-attack.ai`, and by default the API only accepts CORS from `PUBLIC_SITE_URL`
(`CORS_ORIGINS` overrides it). Test the
forms after step 3.

## 3. Domains and TLS

Netlify: **Domain management → Add a domain → `hack-attack.ai`** (add `www.hack-attack.ai` too if Netlify does
not offer it, and keep the apex as primary). Fly:

```sh
fly certs add api.hack-attack.ai -a hack-attack-api
fly certs show api.hack-attack.ai -a hack-attack-api     # prints the exact DNS records Fly wants
```

DNS records at the DNS host (delete the parking A records for the apex first):

| Name | Type | Value |
|---|---|---|
| `hack-attack.ai` | ALIAS/ANAME/flattened CNAME | `apex-loadbalancer.netlify.com` (if supported), else **A** `75.2.60.5` |
| `www` | CNAME | `<project>.netlify.app` |
| `api` | CNAME (or the A/AAAA pair) | as printed by `fly certs show` (normally `hack-attack-api.fly.dev`) |

The Netlify values are Netlify's published external-DNS targets (checked 2026-10-03). Use the values the
Netlify domain screen shows if they differ. Alternative: move the zone to Netlify DNS by changing
nameservers at the registrar, then add the `api` CNAME inside Netlify DNS.

After DNS resolves, Netlify and Fly issue Let's Encrypt certificates on their own. If `PUBLIC_API_URL`
on Netlify was set to the `fly.dev` host, switch it to `https://api.hack-attack.ai` and redeploy.

## 4. Verify

```sh
curl -fsS https://api.hack-attack.ai/healthz
curl -fsSI https://hack-attack.ai/ | grep -i content-security-policy
curl -fsS https://hack-attack.ai/events.json | head
curl -fsS https://api.hack-attack.ai/v1/admin/queue -H "Authorization: Bearer $ADMIN_TOKEN"   # 200, not 401
```

In a browser, load `https://hack-attack.ai`. The Turnstile widget should render, the console should show
no CSP errors, and the consent wording should load from the API. If it is stuck on "Loading consent
wording…", CORS or CSP is wrong.

## Email (before announcing the subscribe form)

With the defaults, every channel is in **dry-run**. Email subscriptions are accepted and recorded, but no
confirmation email is sent. Going live needs the provider decision (`docs/PLAN.md` §6.1) and then:

```sh
fly secrets set -a hack-attack-api SMTP_URL=... EMAIL_FROM=... SENDER_POSTAL_ADDRESS=... \
  SENDER_CONTACT_EMAIL=... CHANNEL_EMAIL_DRY_RUN=false
```

The API refuses to start with live email and missing CASL sender fields (`src/config.ts`). Get a legal
review of the CASL wording first (`docs/PLAN.md` §7).
