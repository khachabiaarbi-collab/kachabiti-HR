-- Run in the Supabase SQL editor.
-- Per-employee monthly annual rate (default 1.5 = 18/12).
-- Annual solde = months worked since hire × rate, capped at rate × 12.
-- Sick (and other non-annual types) get the full yearly default, not monthly.
-- Unpaid stays 0. A future start date gets 0 annual days.

alter table public.employees
  add column if not exists monthly_leave_days numeric default 1.5;

alter table public.employees
  alter column monthly_leave_days set default 1.5;

update public.employees
set monthly_leave_days = 1.5
where monthly_leave_days is null;

create or replace function public.months_worked_since_hire(start_date date)
returns integer
language sql
stable
as $$
  select case
    when start_date is null or start_date > current_date then 0
    else (
      (extract(year from current_date) - extract(year from start_date)) * 12
      + (extract(month from current_date) - extract(month from start_date))
      + 1
    )::integer
  end;
$$;

create or replace function public.entitlement_days(
  default_days numeric,
  start_date date,
  monthly_rate numeric default null
)
returns numeric
language sql
stable
as $$
  select case
    when coalesce(monthly_rate, default_days / 12.0) is null
      or coalesce(monthly_rate, default_days / 12.0) <= 0 then 0
    else least(
      case
        when monthly_rate is not null and monthly_rate > 0 then monthly_rate * 12
        else default_days
      end,
      public.months_worked_since_hire(start_date)
        * coalesce(nullif(monthly_rate, 0), default_days / 12.0)
    )
  end;
$$;

-- Recalculate annual rows that still look like a full yearly grant
-- (fixes hires that received 21 days immediately).
update public.leave_balances as balance
set days_remaining = public.entitlement_days(
  leave_type.default_days,
  employee.start_date,
  employee.monthly_leave_days
)
from public.employees as employee,
     public.leave_types as leave_type
where balance.employee_id = employee.id
  and balance.leave_type_id = leave_type.id
  and (
    leave_type.code in ('VACATION', 'ANNUAL')
    or leave_type.name ~* 'annual|vacation|سنوي'
  )
  and (
    balance.days_remaining = leave_type.default_days
    or balance.days_remaining = round(
      public.entitlement_days(
        leave_type.default_days,
        employee.start_date,
        employee.monthly_leave_days
      )::numeric,
      1
    )
  );

-- Restore sick (and other non-annual, non-unpaid types) that were monthly
-- prorated by mistake. Skip unpaid (default 0).
update public.leave_balances as balance
set days_remaining = leave_type.default_days
from public.employees as employee,
     public.leave_types as leave_type
where balance.employee_id = employee.id
  and balance.leave_type_id = leave_type.id
  and leave_type.default_days > 0
  and leave_type.name !~* 'annual'
  and leave_type.name !~* 'unpaid'
  and balance.days_remaining = round(
    (
      public.months_worked_since_hire(employee.start_date)
      * leave_type.default_days
      / 12.0
    )::numeric,
    1
  );
