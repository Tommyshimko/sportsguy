-- Pro subscription on the wallet (api/_wallet.js, api/revenuecat.js). Run after 2026-09-24-wallets.sql.
-- Safe to run more than once.
--   pro_until    Pro runs until this moment (set from RevenueCat's expiration_at_ms; null = never had it)
--   pro_month    'YYYY-MM' (UTC) that pro_used counts for; a different month means a fresh allowance
--   pro_used     Pro takes spent in pro_month
--   pro_product  pro_monthly | pro_annual
alter table public.wallets
  add column if not exists pro_until   timestamptz,
  add column if not exists pro_month   text,
  add column if not exists pro_used    int not null default 0 check (pro_used >= 0),
  add column if not exists pro_product text;
