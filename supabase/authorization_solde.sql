-- Adds authorizations.leave_days_charged: at approval, the authorization time
-- not covered by punches ÷ 8 h, kept for reference. The vacation balance itself
-- deducts unworked authorization time live (lib/leave-accrual.ts); there is no
-- "free 8 h" quota.

alter table public.authorizations
  add column if not exists leave_days_charged numeric not null default 0;
