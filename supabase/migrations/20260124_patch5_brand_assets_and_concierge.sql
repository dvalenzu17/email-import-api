
-- Patch 5: brand assets refresh metadata + concierge relay outbox/messages

alter table if exists brands add column if not exists assets_provider text;
alter table if exists brands add column if not exists assets_refreshed_at timestamptz;

create table if not exists cancel_request_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references cancel_requests(id) on delete cascade,
  direction text not null check (direction in ('outbound','inbound')),
  channel text not null default 'email' check (channel in ('email','chat')),
  subject text,
  body text,
  to_address text,
  from_address text,
  external_id text,
  created_at timestamptz default now()
);

create index if not exists cancel_request_messages_req_created on cancel_request_messages (request_id, created_at desc);

create table if not exists relay_outbox (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references cancel_requests(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  to_address text not null,
  subject text,
  body text,
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists relay_outbox_status_created on relay_outbox (status, created_at);
