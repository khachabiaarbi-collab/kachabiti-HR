-- Payroll (fiche de paie): contracts, yearly rates, pay components, monthly
-- runs and payslips. Run once in the Supabase SQL editor; safe to re-run.
--
-- Access: salary data is visible to active admins only. Managers do not see
-- contracts or payslips. Employees read their own payslips once the month is
-- validated. Amounts are in TND with 3 decimals (millimes).

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.payroll_is_admin(target_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.employees
    where id = target_id
      and role = 'admin'
      and coalesce(status, 'active') <> 'inactive'
  );
$$;

create or replace function public.payroll_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Contracts (one row per salary version; history is kept)
-- ---------------------------------------------------------------------------

create table if not exists public.employee_contracts (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  effective_from date not null,
  contract_type text not null default 'cdi'
    check (contract_type in ('cdi', 'cdd', 'sivp', 'karama', 'internship', 'other')),
  contract_end date,
  pay_basis text not null default 'monthly'
    check (pay_basis in ('monthly', 'hourly')),
  base_salary numeric(12, 3) not null default 0 check (base_salary >= 0),
  hourly_rate numeric(12, 3) check (hourly_rate is null or hourly_rate >= 0),
  weekly_hours numeric(5, 2) not null default 48 check (weekly_hours > 0 and weekly_hours <= 60),
  cnss_number text,
  marital_status text not null default 'single'
    check (marital_status in ('single', 'married', 'divorced', 'widowed')),
  head_of_family boolean not null default false,
  dependent_children integer not null default 0 check (dependent_children between 0 and 20),
  bank_name text,
  rib text check (rib is null or rib ~ '^[0-9]{20}$'),
  notes text,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_contracts_unique_version unique (employee_id, effective_from),
  constraint employee_contracts_end_after_start
    check (contract_end is null or contract_end >= effective_from),
  constraint employee_contracts_hourly_rate
    check (pay_basis <> 'hourly' or hourly_rate is not null)
);

-- Pay follows the time clock: absent days and missing hours are deducted.
-- Switch off for people who do not punch (e.g. management accounts).
alter table public.employee_contracts
  add column if not exists attendance_based boolean not null default true;

create index if not exists employee_contracts_employee_idx
  on public.employee_contracts (employee_id, effective_from desc);

drop trigger if exists employee_contracts_touch on public.employee_contracts;
create trigger employee_contracts_touch
before update on public.employee_contracts
for each row execute function public.payroll_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Yearly rates. Values change with each Finance Law, so they live here, not
-- in code. A year must be marked verified before a month can be validated.
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_settings (
  year integer primary key check (year between 2020 and 2100),
  cnss_employee_rate numeric(6, 4) not null,
  cnss_employer_rate numeric(6, 4) not null,
  work_accident_rate numeric(6, 4) not null default 0,
  css_rate numeric(6, 4) not null default 0,
  -- [{"up_to": 5000, "rate": 0}, ..., {"up_to": null, "rate": 0.40}] on yearly taxable income
  irpp_brackets jsonb not null,
  professional_expenses_rate numeric(6, 4) not null default 0.10,
  professional_expenses_cap numeric(12, 3) not null default 2000,
  head_of_family_deduction numeric(12, 3) not null default 0,
  child_deduction numeric(12, 3) not null default 0,
  max_children integer not null default 4,
  overtime_rate numeric(6, 4) not null default 1.25,
  verified boolean not null default false,
  verified_by uuid references public.employees (id) on delete set null,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint payroll_settings_brackets_array check (jsonb_typeof(irpp_brackets) = 'array')
);

drop trigger if exists payroll_settings_touch on public.payroll_settings;
create trigger payroll_settings_touch
before update on public.payroll_settings
for each row execute function public.payroll_touch_updated_at();

-- Any rate change needs a fresh verification; verifying stamps who and when.
create or replace function public.payroll_settings_verify()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and (to_jsonb(new) - array['verified', 'verified_by', 'verified_at', 'updated_at'])
      <> (to_jsonb(old) - array['verified', 'verified_by', 'verified_at', 'updated_at'])
    and not (new.verified and not old.verified)
  then
    new.verified := false;
  end if;

  if new.verified then
    if tg_op = 'INSERT' or not old.verified then
      new.verified_by := auth.uid();
      new.verified_at := clock_timestamp();
    end if;
  else
    new.verified_by := null;
    new.verified_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists payroll_settings_verify on public.payroll_settings;
create trigger payroll_settings_verify
before insert or update on public.payroll_settings
for each row execute function public.payroll_settings_verify();

-- Starting values for 2026. NOT VERIFIED: an accountant must confirm every
-- rate (CNSS régime, accident rate for the sector, IRPP brackets, CSS,
-- deductions) in Settings → Payroll before the first month is validated.
insert into public.payroll_settings (
  year, cnss_employee_rate, cnss_employer_rate, work_accident_rate, css_rate,
  irpp_brackets, professional_expenses_rate, professional_expenses_cap,
  head_of_family_deduction, child_deduction, max_children, overtime_rate
) values (
  2026, 0.0918, 0.1657, 0, 0.005,
  '[
    {"up_to": 5000,  "rate": 0},
    {"up_to": 10000, "rate": 0.15},
    {"up_to": 20000, "rate": 0.25},
    {"up_to": 30000, "rate": 0.30},
    {"up_to": 40000, "rate": 0.33},
    {"up_to": 50000, "rate": 0.36},
    {"up_to": 70000, "rate": 0.38},
    {"up_to": null,  "rate": 0.40}
  ]'::jsonb,
  0.10, 2000, 300, 100, 4, 1.25
)
on conflict (year) do nothing;

-- ---------------------------------------------------------------------------
-- Pay components (primes, indemnités, retenues)
-- ---------------------------------------------------------------------------

create table if not exists public.pay_components (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]+$'),
  name text not null check (char_length(trim(name)) > 0),
  kind text not null check (kind in ('earning', 'deduction')),
  subject_to_cnss boolean not null default true,
  taxable boolean not null default true,
  default_amount numeric(12, 3),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.pay_components (code, name, kind, subject_to_cnss, taxable)
values
  ('transport', 'Prime de transport', 'earning', true, true),
  ('presence', 'Prime de présence', 'earning', true, true),
  ('panier', 'Prime de panier', 'earning', true, true),
  ('advance', 'Avance sur salaire', 'deduction', false, false),
  ('loan', 'Remboursement de prêt', 'deduction', false, false)
on conflict (code) do nothing;

create table if not exists public.employee_pay_components (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  component_id uuid not null references public.pay_components (id) on delete restrict,
  amount numeric(12, 3) not null check (amount >= 0),
  starts_on date not null,
  ends_on date,
  created_at timestamptz not null default now(),
  constraint employee_pay_components_dates check (ends_on is null or ends_on >= starts_on)
);

create index if not exists employee_pay_components_employee_idx
  on public.employee_pay_components (employee_id);

-- ---------------------------------------------------------------------------
-- Monthly runs and payslips
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  period date not null unique check (extract(day from period) = 1),
  status text not null default 'draft'
    check (status in ('draft', 'validated', 'paid')),
  settings_snapshot jsonb,
  created_by uuid references public.employees (id) on delete set null,
  validated_by uuid references public.employees (id) on delete set null,
  validated_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bypasses RLS so payslip policies can check the run without recursing.
create or replace function public.payroll_run_published(target_run uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.payroll_runs
    where id = target_run
      and status in ('validated', 'paid')
  );
$$;

drop trigger if exists payroll_runs_touch on public.payroll_runs;
create trigger payroll_runs_touch
before update on public.payroll_runs
for each row execute function public.payroll_touch_updated_at();

create table if not exists public.payslips (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete restrict,
  period date not null,
  -- Copy of every input (employee, contract, attendance, leave) at calculation time.
  inputs jsonb not null default '{}'::jsonb,
  gross numeric(12, 3) not null default 0,
  cnss_employee numeric(12, 3) not null default 0,
  taxable_income numeric(12, 3) not null default 0,
  irpp numeric(12, 3) not null default 0,
  css numeric(12, 3) not null default 0,
  other_deductions numeric(12, 3) not null default 0,
  net numeric(12, 3) not null default 0,
  employer_cnss numeric(12, 3) not null default 0,
  employer_cost numeric(12, 3) not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payslips_one_per_run unique (run_id, employee_id)
);

create index if not exists payslips_employee_idx on public.payslips (employee_id);

drop trigger if exists payslips_touch on public.payslips;
create trigger payslips_touch
before update on public.payslips
for each row execute function public.payroll_touch_updated_at();

create table if not exists public.payslip_lines (
  id uuid primary key default gen_random_uuid(),
  payslip_id uuid not null references public.payslips (id) on delete cascade,
  position integer not null default 0,
  code text not null,
  label text not null,
  kind text not null check (kind in ('earning', 'deduction', 'contribution', 'employer')),
  base numeric(12, 3),
  rate numeric(8, 4),
  amount numeric(12, 3) not null,
  subject_to_cnss boolean not null default false,
  taxable boolean not null default false
);

create index if not exists payslip_lines_payslip_idx
  on public.payslip_lines (payslip_id, position);

-- ---------------------------------------------------------------------------
-- Locking: a validated or paid month cannot change. Corrections go on the
-- next month as a regularisation line.
-- ---------------------------------------------------------------------------

create or replace function public.payroll_run_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Payroll run % is %, it cannot be deleted', old.period, old.status;
    end if;
    return old;
  end if;

  if old.status = 'paid' then
    raise exception 'Payroll run % is paid and locked', old.period;
  end if;
  if old.status = 'validated' and new.status not in ('validated', 'paid') then
    raise exception 'Payroll run % is validated and cannot go back to draft', old.period;
  end if;
  if old.status = 'validated' and new.period <> old.period then
    raise exception 'Payroll run % is validated and locked', old.period;
  end if;

  if new.status = 'validated' and old.status = 'draft' then
    -- Pay depends on the whole month of attendance.
    if (new.period + interval '1 month')::date > (now() at time zone 'Africa/Tunis')::date then
      raise exception 'Payroll month % is not finished yet', to_char(new.period, 'YYYY-MM');
    end if;
    if not exists (
      select 1 from public.payroll_settings
      where year = extract(year from new.period)::integer and verified
    ) then
      raise exception 'Payroll rates for % are not verified', extract(year from new.period);
    end if;
    new.validated_at := coalesce(new.validated_at, clock_timestamp());
    new.validated_by := coalesce(new.validated_by, auth.uid());
  end if;
  if new.status = 'paid' and old.status <> 'paid' then
    new.paid_at := coalesce(new.paid_at, clock_timestamp());
  end if;
  return new;
end;
$$;

drop trigger if exists payroll_runs_guard on public.payroll_runs;
create trigger payroll_runs_guard
before update or delete on public.payroll_runs
for each row execute function public.payroll_run_guard();

create or replace function public.payslip_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_run uuid;
  run_status text;
begin
  if tg_table_name = 'payslip_lines' then
    select payslip.run_id into target_run
    from public.payslips payslip
    where payslip.id = coalesce(new.payslip_id, old.payslip_id);
  else
    target_run := coalesce(new.run_id, old.run_id);
  end if;

  select status into run_status from public.payroll_runs where id = target_run;
  -- The run row itself is gone during a cascade delete of a draft run.
  if run_status is not null and run_status <> 'draft' then
    raise exception 'Payslips of a % payroll run cannot be changed', run_status;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists payslips_guard on public.payslips;
create trigger payslips_guard
before insert or update or delete on public.payslips
for each row execute function public.payslip_guard();

drop trigger if exists payslip_lines_guard on public.payslip_lines;
create trigger payslip_lines_guard
before insert or update or delete on public.payslip_lines
for each row execute function public.payslip_guard();

-- ---------------------------------------------------------------------------
-- Audit log for contracts, rates and runs
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.employees (id) on delete set null,
  table_name text not null,
  record_id text not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists payroll_audit_record_idx
  on public.payroll_audit_log (table_name, record_id, created_at desc);

create or replace function public.payroll_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.payroll_audit_log (actor_id, table_name, record_id, action, old_data, new_data)
  values (
    auth.uid(),
    tg_table_name,
    coalesce(row_data ->> 'id', row_data ->> 'year'),
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists employee_contracts_audit on public.employee_contracts;
create trigger employee_contracts_audit
after insert or update or delete on public.employee_contracts
for each row execute function public.payroll_audit();

drop trigger if exists payroll_settings_audit on public.payroll_settings;
create trigger payroll_settings_audit
after insert or update or delete on public.payroll_settings
for each row execute function public.payroll_audit();

drop trigger if exists payroll_runs_audit on public.payroll_runs;
create trigger payroll_runs_audit
after insert or update or delete on public.payroll_runs
for each row execute function public.payroll_audit();

drop trigger if exists employee_pay_components_audit on public.employee_pay_components;
create trigger employee_pay_components_audit
after insert or update or delete on public.employee_pay_components
for each row execute function public.payroll_audit();

-- ---------------------------------------------------------------------------
-- Attendance for payroll: per employee and day of [p_from, p_to], the minutes
-- scheduled (work segments of their schedule), worked (completed punch
-- sessions) and covered by approved authorizations. Needs attendance.sql;
-- plpgsql so payroll.sql still installs when attendance is not set up yet.
-- ---------------------------------------------------------------------------

-- Return shape changed (time windows added): drop before re-creating.
drop function if exists public.payroll_attendance_month(date, date);

create or replace function public.payroll_attendance_month(p_from date, p_to date)
returns table (
  employee_id uuid,
  work_date date,
  scheduled_minutes integer,
  worked_minutes integer,
  authorized_minutes integer,
  -- Tunis local times "HH24:MI", for the quarter-hour discipline rules.
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
  if not public.payroll_is_admin() then
    raise exception using message = 'FORBIDDEN';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 31 then
    raise exception using message = 'INVALID_DATE_RANGE';
  end if;

  for person in
    select employee.id from public.employees employee
    where coalesce(employee.status, 'active') <> 'inactive'
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
        worked_minutes := coalesce((summary ->> 'workedMinutes')::integer, 0);
        select coalesce(jsonb_agg(jsonb_build_object(
          'in', to_char(((item ->> 'entryAt')::timestamptz at time zone 'Africa/Tunis'), 'HH24:MI'),
          'out', case when item ->> 'exitAt' is null then null
            else to_char(((item ->> 'exitAt')::timestamptz at time zone 'Africa/Tunis'), 'HH24:MI') end
        )), '[]'::jsonb)
        into sessions
        from jsonb_array_elements(coalesce(summary -> 'sessions', '[]'::jsonb)) item;
      else
        worked_minutes := 0;
        sessions := '[]'::jsonb;
      end if;

      select
        coalesce(sum(item.duration_minutes), 0)::integer,
        coalesce(jsonb_agg(jsonb_build_object(
          'start', to_char(item.start_time, 'HH24:MI'),
          'end', to_char(item.end_time, 'HH24:MI')
        )), '[]'::jsonb)
      into authorized_minutes, authorizations
      from public.authorizations item
      where item.employee_id = person.id and item.date = day and item.status = 'approved';

      return next;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Employer details printed on every payslip (single row)
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_company (
  id integer primary key default 1 check (id = 1),
  name text not null default 'Kachabiti',
  address text,
  tax_id text,
  cnss_employer_number text,
  updated_at timestamptz not null default now()
);

insert into public.payroll_company (id) values (1) on conflict (id) do nothing;

drop trigger if exists payroll_company_touch on public.payroll_company;
create trigger payroll_company_touch
before update on public.payroll_company
for each row execute function public.payroll_touch_updated_at();

-- ---------------------------------------------------------------------------
-- "Your payslip is available" notice when a month is validated. Needs
-- supabase/notifications.sql; skipped quietly if that table is missing.
-- ---------------------------------------------------------------------------

create or replace function public.payroll_notify_validated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'validated' and old.status = 'draft'
    and to_regclass('public.notifications') is not null
  then
    insert into public.notifications (user_id, type, message)
    select payslip.employee_id,
      'reminder',
      'Your payslip for ' || to_char(new.period, 'YYYY-MM') || ' is available.'
    from public.payslips payslip
    where payslip.run_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists payroll_runs_notify on public.payroll_runs;
create trigger payroll_runs_notify
after update of status on public.payroll_runs
for each row execute function public.payroll_notify_validated();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.employee_contracts enable row level security;
alter table public.payroll_settings enable row level security;
alter table public.pay_components enable row level security;
alter table public.employee_pay_components enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payslips enable row level security;
alter table public.payslip_lines enable row level security;
alter table public.payroll_audit_log enable row level security;
alter table public.payroll_company enable row level security;

grant select, insert, update, delete on table
  public.employee_contracts,
  public.payroll_settings,
  public.pay_components,
  public.employee_pay_components,
  public.payroll_runs,
  public.payslips,
  public.payslip_lines
to authenticated;
grant select on table public.payroll_audit_log to authenticated;
grant select, update on table public.payroll_company to authenticated;
revoke insert, update, delete on public.payroll_audit_log from authenticated;

drop policy if exists "employee_contracts_admin" on public.employee_contracts;
create policy "employee_contracts_admin" on public.employee_contracts
for all to authenticated using (public.payroll_is_admin())
with check (public.payroll_is_admin());

drop policy if exists "payroll_settings_admin" on public.payroll_settings;
create policy "payroll_settings_admin" on public.payroll_settings
for all to authenticated using (public.payroll_is_admin())
with check (public.payroll_is_admin());

drop policy if exists "pay_components_admin" on public.pay_components;
create policy "pay_components_admin" on public.pay_components
for all to authenticated using (public.payroll_is_admin())
with check (public.payroll_is_admin());

drop policy if exists "employee_pay_components_admin" on public.employee_pay_components;
create policy "employee_pay_components_admin" on public.employee_pay_components
for all to authenticated using (public.payroll_is_admin())
with check (public.payroll_is_admin());

drop policy if exists "payroll_runs_admin" on public.payroll_runs;
create policy "payroll_runs_admin" on public.payroll_runs
for all to authenticated using (public.payroll_is_admin())
with check (public.payroll_is_admin());

-- Employees never read runs directly; payslips carry their own period.
drop policy if exists "payroll_runs_read_own_published" on public.payroll_runs;

drop policy if exists "payslips_admin" on public.payslips;
create policy "payslips_admin" on public.payslips
for all to authenticated using (public.payroll_is_admin())
with check (public.payroll_is_admin());

drop policy if exists "payslips_read_own_published" on public.payslips;
create policy "payslips_read_own_published" on public.payslips
for select to authenticated using (
  employee_id = auth.uid()
  and public.payroll_run_published(run_id)
);

drop policy if exists "payslip_lines_admin" on public.payslip_lines;
create policy "payslip_lines_admin" on public.payslip_lines
for all to authenticated using (public.payroll_is_admin())
with check (public.payroll_is_admin());

drop policy if exists "payslip_lines_read_own_published" on public.payslip_lines;
create policy "payslip_lines_read_own_published" on public.payslip_lines
for select to authenticated using (
  exists (
    select 1
    from public.payslips payslip
    where payslip.id = payslip_lines.payslip_id
      and payslip.employee_id = auth.uid()
      and public.payroll_run_published(payslip.run_id)
  )
);

-- Everyone with a payslip needs the employer details printed on it.
drop policy if exists "payroll_company_read" on public.payroll_company;
create policy "payroll_company_read" on public.payroll_company
for select to authenticated using (true);
drop policy if exists "payroll_company_admin_write" on public.payroll_company;
create policy "payroll_company_admin_write" on public.payroll_company
for update to authenticated using (public.payroll_is_admin())
with check (public.payroll_is_admin());

drop policy if exists "payroll_audit_admin_read" on public.payroll_audit_log;
create policy "payroll_audit_admin_read" on public.payroll_audit_log
for select to authenticated using (public.payroll_is_admin());

revoke all on function public.payroll_is_admin(uuid) from public;
grant execute on function public.payroll_is_admin(uuid) to authenticated;
revoke all on function public.payroll_run_published(uuid) from public;
grant execute on function public.payroll_run_published(uuid) to authenticated;
revoke all on function public.payroll_audit() from public;
revoke all on function public.payroll_notify_validated() from public;
revoke all on function public.payroll_attendance_month(date, date) from public;
grant execute on function public.payroll_attendance_month(date, date) to authenticated;
