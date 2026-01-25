-- Patch 1: Evidence-backed canonical model for subscriptions + optimization primitives
-- Safe to run multiple times (IF NOT EXISTS).

create extension if not exists pgcrypto;

create table if not exists brands (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  canonical_name text not null,
  logo_url text,
  color text,
  created_at timestamptz default now()
);

create unique index if not exists brands_slug_key on brands (lower(slug));
create unique index if not exists brands_canonical_name_key on brands (lower(canonical_name));

create table if not exists brand_aliases (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  kind text not null check (kind in ('domain','sender','unsubscribe_domain')),
  alias text not null,
  created_at timestamptz default now()
);

create unique index if not exists brand_aliases_unique on brand_aliases (kind, lower(alias));

create table if not exists email_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  message_id text not null,
  thread_id text,
  from_domain text,
  from_name text,
  subject text,
  sent_at timestamptz,
  html text,
  text text,
  attachments_meta jsonb,
  created_at timestamptz default now()
);

create unique index if not exists email_messages_unique on email_messages (user_id, provider, message_id);

create table if not exists signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  email_message_id uuid references email_messages(id) on delete set null,
  type text not null check (type in ('receipt','renewal','trial','price_change','cancel_confirm')),
  extracted jsonb not null default '{}'::jsonb,
  confidence numeric not null default 0,
  raw_spans jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists signals_user_type_created on signals (user_id, type, created_at desc);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  brand_id uuid not null references brands(id) on delete restrict,
  plan text,
  amount numeric,
  currency text,
  cadence text,
  next_charge_at timestamptz,
  status text not null default 'active',
  last_evidence_id uuid references signals(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists subscriptions_user_brand_plan_cadence_uniq
on subscriptions (user_id, brand_id, coalesce(plan,''), coalesce(cadence,''));

create table if not exists trials (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  ends_at timestamptz not null,
  source_signal_id uuid references signals(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists trials_ends_at on trials (ends_at);

create table if not exists actions (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  type text not null check (type in ('cancel','downgrade','annual_switch')),
  status text not null default 'queued',
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
