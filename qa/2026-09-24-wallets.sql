-- Wallets (api/_wallet.js) and the store events that fill them (api/revenuecat.js).
-- Only the server touches these, with the service key: RLS is on and there are NO policies, so the
-- anon and signed-in roles can neither read nor write them. Safe to run more than once.

create table if not exists public.wallets (
  id          text primary key,                 -- RevenueCat app user id, Supabase user id, or ip:<addr>
  paid        int  not null default 0 check (paid >= 0),
  free_day    date,                             -- UTC day free_used counts for
  free_used   int  not null default 0 check (free_used >= 0),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists public.purchases (
  event_id  text primary key,                   -- RevenueCat event id: each event applied once
  wallet    text not null,
  product   text not null,
  takes     int  not null,
  kind      text not null,                      -- purchase | refund | transfer
  store     text,
  at        timestamptz default now()
);

create index if not exists purchases_wallet_idx on public.purchases (wallet);

alter table public.wallets   enable row level security;
alter table public.purchases enable row level security;

revoke all on public.wallets   from anon, authenticated;
revoke all on public.purchases from anon, authenticated;
