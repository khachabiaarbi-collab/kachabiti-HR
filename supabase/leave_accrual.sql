-- Vacation earned from the time clock. Run after attendance.sql and
-- employee_solde.sql; safe to re-run.
--
-- The vacation balance shown everywhere is:
--   leave_balances (opening balance entered by the admin, minus everything
--   deducted on approval) + days earned from credited hours since the hire
--   date - approved authorization time that was not worked.
-- Earned days per month = credited hours ÷ scheduled hours × the month's rate.

-- ---------------------------------------------------------------------------
-- Rate history: a change applies from the current month on; past months keep
-- the rate they were earned at.
-- ---------------------------------------------------------------------------

create table if not exists public.leave_rate_changes (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  effective_month date not null check (extract(day from effective_month) = 1),
  monthly_days numeric(6, 3) not null check (monthly_days > 0),
  changed_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint leave_rate_changes_one_per_month unique (employee_id, effective_month)
);

create index if not exists leave_rate_changes_employee_idx
  on public.leave_rate_changes (employee_id, effective_month desc);

create or replace function public.leave_rate_record_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  this_month date := date_trunc('month', (now() at time zone 'Africa/Tunis'))::date;
begin
  if new.monthly_leave_days is null
    or new.monthly_leave_days is not distinct from old.monthly_leave_days then
    return new;
  end if;
  -- First change: keep the old rate for every earlier month.
  if not exists (select 1 from public.leave_rate_changes where employee_id = new.id)
    and old.monthly_leave_days is not null then
    insert into public.leave_rate_changes (employee_id, effective_month, monthly_days, changed_by)
    values (new.id, date '2000-01-01', old.monthly_leave_days, auth.uid());
  end if;
  insert into public.leave_rate_changes (employee_id, effective_month, monthly_days, changed_by)
  values (new.id, this_month, new.monthly_leave_days, auth.uid())
  on conflict (employee_id, effective_month)
  do update set monthly_days = excluded.monthly_days, changed_by = excluded.changed_by, created_at = now();
  return new;
end;
$$;

drop trigger if exists employees_leave_rate_history on public.employees;
create trigger employees_leave_rate_history
after update of monthly_leave_days on public.employees
for each row execute function public.leave_rate_record_change();

alter table public.leave_rate_changes enable row level security;
grant select on table public.leave_rate_changes to authenticated;
revoke insert, update, delete on public.leave_rate_changes from authenticated;

drop policy if exists "leave_rate_changes_read" on public.leave_rate_changes;
create policy "leave_rate_changes_read" on public.leave_rate_changes
for select to authenticated using (
  employee_id = auth.uid() or public.attendance_is_staff()
);

-- ---------------------------------------------------------------------------
-- Time-clock windows per employee and day (Tunis local "HH24:MI"): the
-- schedule's work segments, the punch sessions and approved authorizations.
-- An employee reads their own; admin and manager read anyone, or everyone
-- when p_employee_id is null.
-- ---------------------------------------------------------------------------

create or replace function public.attendance_credit_windows(
  p_employee_id uuid,
  p_from date,
  p_to date
)
returns table (
  employee_id uuid,
  work_date date,
  scheduled_minutes integer,
  segments jsonb,
  sessions jsonb,
  authorizations jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  person record;
  day date;
  schedule_value uuid;
  summary jsonb;
begin
  if auth.uid() is null then
    raise exception using message = 'UNAUTHENTICATED';
  end if;
  if (p_employee_id is null or p_employee_id <> auth.uid()) and not public.attendance_is_staff() then
    raise exception using message = 'FORBIDDEN';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception using message = 'INVALID_DATE_RANGE';
  end if;

  for person in
    select employee.id from public.employees employee
    where (p_employee_id is null or employee.id = p_employee_id)
      and coalesce(employee.status, 'active') <> 'inactive'
  loop
    for day in select generate_series(p_from, p_to, interval '1 day')::date loop
      schedule_value := public.attendance_resolved_schedule(person.id, day);
      employee_id := person.id;
      work_date := day;

      select
        coalesce(sum(extract(epoch from (segment.end_time - segment.start_time)) / 60), 0)::integer,
        coalesce(jsonb_agg(jsonb_build_object(
          'start', to_char(segment.start_time, 'HH24:MI'),
          'end', to_char(segment.end_time, 'HH24:MI')
        ) order by segment.start_time), '[]'::jsonb)
      into scheduled_minutes, segments
      from public.work_schedule_segments segment
      where segment.schedule_id = schedule_value
        and segment.kind = 'work'
        and segment.iso_weekday = extract(isodow from day)::integer;

      if exists (
        select 1 from public.attendance_punches punch
        where punch.employee_id = person.id and punch.work_date = day and punch.voided_at is null
      ) then
        summary := public.attendance_day_summary(person.id, day, clock_timestamp());
        select coalesce(jsonb_agg(jsonb_build_object(
          'in', to_char(((item ->> 'entryAt')::timestamptz at time zone 'Africa/Tunis'), 'HH24:MI'),
          'out', case when item ->> 'exitAt' is null then null
            else to_char(((item ->> 'exitAt')::timestamptz at time zone 'Africa/Tunis'), 'HH24:MI') end
        )), '[]'::jsonb)
        into sessions
        from jsonb_array_elements(coalesce(summary -> 'sessions', '[]'::jsonb)) item;
      else
        sessions := '[]'::jsonb;
      end if;

      select coalesce(jsonb_agg(jsonb_build_object(
        'start', to_char(item.start_time, 'HH24:MI'),
        'end', to_char(item.end_time, 'HH24:MI')
      )), '[]'::jsonb)
      into authorizations
      from public.authorizations item
      where item.employee_id = person.id and item.date = day and item.status = 'approved';

      return next;
    end loop;
  end loop;
end;
$$;

revoke all on function public.attendance_credit_windows(uuid, date, date) from public;
grant execute on function public.attendance_credit_windows(uuid, date, date) to authenticated;
revoke all on function public.leave_rate_record_change() from public;
