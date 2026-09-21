-- Run in the Supabase SQL editor so extra authorization time over 8h
-- can deduct vacation days (and catch up people who already exceeded 8h).

alter table public.authorizations
  add column if not exists leave_days_charged numeric not null default 0;
