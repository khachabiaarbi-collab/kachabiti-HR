-- Run once in the Supabase SQL editor so hour-based authorizations
-- live in their own table (not leave_requests).

create table if not exists public.authorizations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  date date not null,
  start_time time not null,
  end_time time not null,
  duration_minutes integer not null check (duration_minutes > 0),
  reason text not null check (char_length(trim(reason)) > 0),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  approver_id uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  leave_days_charged numeric not null default 0,
  constraint authorizations_end_after_start check (end_time > start_time)
);

create index if not exists authorizations_employee_id_idx
  on public.authorizations (employee_id);

create index if not exists authorizations_status_idx
  on public.authorizations (status);

alter table public.authorizations enable row level security;

grant select, insert, update, delete on table public.authorizations to authenticated;

drop policy if exists "authorizations_select_own_or_staff" on public.authorizations;
drop policy if exists "authorizations_insert_own_pending" on public.authorizations;
drop policy if exists "authorizations_update_staff" on public.authorizations;

-- Employees read their own rows; admin/manager read all.
create policy "authorizations_select_own_or_staff"
on public.authorizations
for select
to authenticated
using (
  employee_id = auth.uid()
  or exists (
    select 1 from public.employees
    where id = auth.uid()
      and role in ('admin', 'manager')
  )
);

-- Employees open their own pending requests only.
create policy "authorizations_insert_own_pending"
on public.authorizations
for insert
to authenticated
with check (
  employee_id = auth.uid()
  and status = 'pending'
  and approver_id is null
);

-- Staff approve or reject.
create policy "authorizations_update_staff"
on public.authorizations
for update
to authenticated
using (
  exists (
    select 1 from public.employees
    where id = auth.uid()
      and role in ('admin', 'manager')
  )
)
with check (
  exists (
    select 1 from public.employees
    where id = auth.uid()
      and role in ('admin', 'manager')
  )
);
