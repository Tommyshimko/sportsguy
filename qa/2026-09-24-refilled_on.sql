-- Free daily takes (api/_account.js FREE_PER_DAY). Records the UTC day a signed-in person's balance
-- was last topped up, so the top-up happens at most once a day. Safe to run more than once.
alter table public.profiles add column if not exists refilled_on date;
