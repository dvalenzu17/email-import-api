
-- Patch 4: cancellation concierge requests
create table if not exists cancel_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  brand_id uuid references brands(id) on delete set null,
  country text,
  status text not null default 'queued' check (status in ('queued','in_progress','waiting_user','done','failed')),
  relay_email text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists cancel_requests_user_created on cancel_requests (user_id, created_at desc);

create table if not exists cancel_request_updates (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references cancel_requests(id) on delete cascade,
  status text,
  note text,
  created_at timestamptz default now()
);

create index if not exists cancel_request_updates_req on cancel_request_updates (request_id, created_at desc);
