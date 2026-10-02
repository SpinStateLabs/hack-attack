-- HACK-ATTACK v0 schema: events, subscriptions, consent evidence, outbox, audit.

create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- Events (the registry entries that get broadcast)
-- ---------------------------------------------------------------------------
create table events (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title             text not null check (length(title) between 1 and 200),
  summary           text not null check (length(summary) between 1 and 1000),
  body              text not null default '',
  severity          text not null check (severity in ('info','low','medium','high','critical')),
  categories        text[] not null default '{}',
  sources           jsonb not null default '[]',
  status            text not null default 'draft'
                    check (status in ('draft','unconfirmed','confirmed','retracted')),
  human_approved    boolean not null default false,
  approved_by       text,
  approved_at       timestamptz,
  broadcast_at      timestamptz,
  retracted_at      timestamptz,
  retraction_reason text,
  version           integer not null default 1,
  created_by        text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (not human_approved or (approved_by is not null and approved_at is not null)),
  check (status <> 'retracted' or (retracted_at is not null and retraction_reason is not null))
);
create index events_public_idx on events (broadcast_at desc) where broadcast_at is not null;

-- ---------------------------------------------------------------------------
-- Email subscribers and CASL consent evidence
-- ---------------------------------------------------------------------------
create table email_subscribers (
  id               uuid primary key default gen_random_uuid(),
  email            citext not null unique,
  status           text not null default 'pending' check (status in ('pending','active','unsubscribed')),
  categories       text[] not null default '{}',          -- empty = all categories
  min_severity     text not null default 'high'
                   check (min_severity in ('info','low','medium','high','critical')),
  delivery         text not null default 'instant' check (delivery in ('instant','digest')),
  token_epoch      integer not null default 1,             -- bump to revoke all outstanding links
  created_at       timestamptz not null default now(),
  confirmed_at     timestamptz,
  unsubscribed_at  timestamptz,
  updated_at       timestamptz not null default now()
);

-- Append-only record of how and when consent was requested, given, changed and withdrawn.
create table consent_records (
  id             bigserial primary key,
  subscriber_id  uuid not null references email_subscribers(id),
  email          citext not null,
  action         text not null check (action in ('requested','confirmed','preferences_updated','withdrawn')),
  consent_type   text not null default 'express',
  consent_text   text not null,           -- exact wording shown to the person
  consent_text_version text not null,
  method         text not null,           -- e.g. web-form, confirm-link, one-click-unsubscribe
  ip             inet,
  user_agent     text,
  details        jsonb not null default '{}',
  occurred_at    timestamptz not null default now()
);
create index consent_records_subscriber_idx on consent_records (subscriber_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Webhook endpoints
-- ---------------------------------------------------------------------------
create table webhook_endpoints (
  id                    uuid primary key default gen_random_uuid(),
  url                   text not null,
  status                text not null default 'pending_verification'
                        check (status in ('pending_verification','active','disabled')),
  categories            text[] not null default '{}',
  min_severity          text not null default 'high'
                        check (min_severity in ('info','low','medium','high','critical')),
  secret_ciphertext     text,                -- AES-256-GCM, key from SECRET_ENCRYPTION_KEY
  management_token_hash text not null,       -- sha256 of the token returned once at registration
  consecutive_failures  integer not null default 0,
  disabled_at           timestamptz,
  disabled_reason       text,
  verified_at           timestamptz,
  created_ip            inet,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Outbox: one row per (channel, recipient, event, kind). Idempotency key is unique.
-- ---------------------------------------------------------------------------
create table outbox (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text not null unique,
  channel          text not null,
  kind             text not null check (kind in ('publish','retraction','digest','transactional','test')),
  event_id         uuid references events(id),
  recipient_id     uuid,                     -- email_subscribers.id or webhook_endpoints.id
  mode             text not null check (mode in ('auto','assisted','manual-queue')),
  dry_run          boolean not null,
  status           text not null default 'pending'
                   check (status in ('pending','in_progress','sent','dry_run','awaiting_operator',
                                     'needs_review','failed','cancelled','skipped')),
  payload          jsonb not null,
  attempts         integer not null default 0,
  max_attempts     integer not null default 5,
  next_attempt_at  timestamptz not null default now(),
  lease_until      timestamptz,
  last_error       text,
  depends_on       uuid references outbox(id),   -- retraction waits for its original
  external_id      text,
  external_url     text,
  cost_usd         numeric(10,4),
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  updated_at       timestamptz not null default now()
);
create index outbox_due_idx on outbox (next_attempt_at) where status = 'pending';
create index outbox_event_idx on outbox (event_id, channel, kind);
create index outbox_operator_idx on outbox (created_at) where status in ('awaiting_operator','needs_review');

-- Global broadcast gate, enforced in the database as well as in application code:
-- publish rows may only exist for events that are confirmed AND human-approved;
-- retraction rows only for retracted events.
create function outbox_gate() returns trigger language plpgsql as $$
declare
  ev record;
begin
  if new.kind in ('publish','retraction') then
    select status, human_approved into ev from events where id = new.event_id;
    if not found then
      raise exception 'outbox gate: event % not found', new.event_id;
    end if;
    if new.kind = 'publish' and not (ev.status = 'confirmed' and ev.human_approved) then
      raise exception 'outbox gate: event % is not confirmed and human-approved', new.event_id;
    end if;
    if new.kind = 'retraction' and ev.status <> 'retracted' then
      raise exception 'outbox gate: event % is not retracted', new.event_id;
    end if;
  end if;
  return new;
end $$;
create trigger outbox_gate before insert on outbox for each row execute function outbox_gate();

-- Digest: events waiting to be bundled into a subscriber's next digest email.
create table digest_items (
  subscriber_id uuid not null references email_subscribers(id),
  event_id      uuid not null references events(id),
  outbox_id     uuid references outbox(id),  -- set when bundled into a digest message
  created_at    timestamptz not null default now(),
  primary key (subscriber_id, event_id)
);

-- X spend ledger. One row per post attempt that reached the API.
create table channel_spend (
  id          bigserial primary key,
  channel     text not null,
  outbox_id   uuid references outbox(id),
  cost_usd    numeric(10,4) not null,
  with_url    boolean not null,
  occurred_at timestamptz not null default now()
);
create index channel_spend_month_idx on channel_spend (channel, occurred_at);

-- Fixed-window rate limiter shared by all API machines.
create table rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        integer not null,
  primary key (key, window_start)
);

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
create table audit_log (
  id          bigserial primary key,
  occurred_at timestamptz not null default now(),
  actor       text not null,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  details     jsonb not null default '{}'
);
create index audit_log_entity_idx on audit_log (entity_type, entity_id, occurred_at);

create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger audit_log_append_only before update or delete on audit_log
  for each statement execute function forbid_mutation();
create trigger consent_records_append_only before update or delete on consent_records
  for each statement execute function forbid_mutation();
