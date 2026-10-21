-- RHFlow multi-company foundation (SaaS step 1).
--
-- Run in the Supabase SQL editor, before every other script in supabase/.
-- Safe to run again. It works on two kinds of database:
--   * a new, empty project: creates the core tables;
--   * the existing single-company database: adds a company to every core
--     row (all current rows go to one company, see EXISTING_COMPANY below).
--
-- What it adds:
--   * public.organizations: one row per customer company;
--   * organization_id on employees, departments, leave_types, leave_balances,
--     leave_requests and events, filled in automatically;
--   * current_org_id(), is_org_staff(), is_org_admin() for RLS;
--   * RLS on those tables: a user only sees and changes their own company;
--   * the new-user trigger: invited users join the inviter's company, a
--     self sign-up with a company name creates a new company.
--
-- Attendance, authorizations, payroll, notifications and leave attachments
-- are limited to the company by their own scripts (SaaS step 2), which need
-- this one to have run first.

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  slug text not null unique
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

alter table public.organizations enable row level security;

-- Lowercase, dash-separated, unique slug from a company name.
create or replace function public.organization_slug(p_name text)
returns text
language plpgsql
set search_path = public
as $$
declare
  base text := trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'));
  candidate text;
  n integer := 1;
begin
  base := left(coalesce(nullif(base, ''), 'company'), 40);
  base := trim(both '-' from base);
  candidate := base;
  while exists (select 1 from public.organizations where slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;
  return candidate;
end;
$$;

-- ---------------------------------------------------------------------------
-- Core tables (no-op when they already exist)
-- ---------------------------------------------------------------------------

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  manager_id uuid,
  created_at timestamptz default now()
);

create table if not exists public.employees (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  email text not null,
  phone text,
  department_id uuid references public.departments (id) on delete set null,
  job_title text,
  role text not null default 'employee',
  status text not null default 'active',
  start_date date,
  avatar_url text,
  created_at timestamptz default now(),
  monthly_leave_days numeric default 1.5
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.departments'::regclass
      and contype = 'f'
      and conkey = array[(
        select attnum from pg_attribute
        where attrelid = 'public.departments'::regclass and attname = 'manager_id'
      )]
  ) then
    alter table public.departments
      add constraint departments_manager_id_fkey
      foreign key (manager_id) references public.employees (id) on delete set null;
  end if;
end;
$$;

create table if not exists public.leave_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  default_days integer not null default 0,
  code text
);

create table if not exists public.leave_balances (
  employee_id uuid not null references public.employees (id) on delete cascade,
  leave_type_id uuid not null references public.leave_types (id) on delete cascade,
  days_remaining numeric not null default 0,
  primary key (employee_id, leave_type_id)
);

create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees (id) on delete cascade,
  leave_type_id uuid references public.leave_types (id) on delete set null,
  start_date date not null,
  end_date date not null,
  reason text,
  status text not null default 'pending',
  approver_id uuid references public.employees (id) on delete set null,
  created_at timestamptz default now(),
  attachment_path text,
  attachment_name text
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  start_date date not null,
  end_date date not null,
  type text not null default 'other',
  description text
);

-- ---------------------------------------------------------------------------
-- Company column on every core table
-- ---------------------------------------------------------------------------

alter table public.employees
  add column if not exists organization_id uuid references public.organizations (id) on delete cascade;
alter table public.departments
  add column if not exists organization_id uuid references public.organizations (id) on delete cascade;
alter table public.leave_types
  add column if not exists organization_id uuid references public.organizations (id) on delete cascade;
alter table public.leave_balances
  add column if not exists organization_id uuid references public.organizations (id) on delete cascade;
alter table public.leave_requests
  add column if not exists organization_id uuid references public.organizations (id) on delete cascade;
alter table public.events
  add column if not exists organization_id uuid references public.organizations (id) on delete cascade;

-- Existing single-company data: every row without a company goes to one
-- company. EXISTING_COMPANY is its name; change it before the first run if
-- needed. On an empty database nothing is created here.
do $$
declare
  existing_company constant text := 'Kachabiti';
  org uuid;
begin
  if exists (select 1 from public.employees where organization_id is null)
     or exists (select 1 from public.departments where organization_id is null)
     or exists (select 1 from public.leave_types where organization_id is null)
     or exists (select 1 from public.events where organization_id is null) then
    select id into org from public.organizations order by created_at limit 1;
    if org is null then
      insert into public.organizations (name, slug)
      values (existing_company, public.organization_slug(existing_company))
      returning id into org;
    end if;
    update public.employees set organization_id = org where organization_id is null;
    update public.departments set organization_id = org where organization_id is null;
    update public.leave_types set organization_id = org where organization_id is null;
    update public.events set organization_id = org where organization_id is null;
  end if;

  update public.leave_balances as balance
  set organization_id = employee.organization_id
  from public.employees as employee
  where balance.organization_id is null and employee.id = balance.employee_id;

  update public.leave_requests as request
  set organization_id = employee.organization_id
  from public.employees as employee
  where request.organization_id is null and employee.id = request.employee_id;

  -- A request with no employee cannot belong to anyone: keep it in the
  -- oldest company rather than failing the not-null below.
  update public.leave_requests
  set organization_id = (select id from public.organizations order by created_at limit 1)
  where organization_id is null;
end;
$$;

alter table public.employees alter column organization_id set not null;
alter table public.departments alter column organization_id set not null;
alter table public.leave_types alter column organization_id set not null;
alter table public.leave_balances alter column organization_id set not null;
alter table public.leave_requests alter column organization_id set not null;
alter table public.events alter column organization_id set not null;

create index if not exists employees_organization_idx on public.employees (organization_id);
create index if not exists departments_organization_idx on public.departments (organization_id);
create index if not exists leave_types_organization_idx on public.leave_types (organization_id);
create index if not exists leave_balances_organization_idx on public.leave_balances (organization_id);
create index if not exists leave_requests_organization_idx on public.leave_requests (organization_id);
create index if not exists events_organization_idx on public.events (organization_id);

-- Leave type codes are unique per company, not across the database.
drop index if exists public.leave_types_code_key;
create unique index if not exists leave_types_org_code_key
  on public.leave_types (organization_id, code)
  where code is not null;

-- ---------------------------------------------------------------------------
-- Who is asking
-- ---------------------------------------------------------------------------

-- Company of the signed-in user; null for the service role and anonymous.
create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from public.employees where id = auth.uid();
$$;

-- Active admin or manager of their company.
create or replace function public.is_org_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.employees
    where id = auth.uid()
      and role in ('admin', 'manager')
      and coalesce(status, 'active') <> 'inactive'
  );
$$;

-- Active admin of their company.
create or replace function public.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.employees
    where id = auth.uid()
      and role = 'admin'
      and coalesce(status, 'active') <> 'inactive'
  );
$$;

-- This employee belongs to the signed-in user's company. Used by the RLS of
-- tables that hang off an employee (punches, authorizations, payslips, …)
-- and by security definer functions before they act on an employee.
create or replace function public.is_my_org_employee(target_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.employees
    where id = target_id
      and organization_id = public.current_org_id()
  );
$$;

grant execute on function public.current_org_id() to authenticated;
grant execute on function public.is_org_staff() to authenticated;
grant execute on function public.is_org_admin() to authenticated;
grant execute on function public.is_my_org_employee(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Filling in and protecting the company column
-- ---------------------------------------------------------------------------

-- Rows created from the app get the signed-in user's company.
alter table public.departments alter column organization_id set default public.current_org_id();
alter table public.leave_types alter column organization_id set default public.current_org_id();
alter table public.events alter column organization_id set default public.current_org_id();
alter table public.employees alter column organization_id set default public.current_org_id();

-- Balances and requests always belong to their employee's company, and must
-- use a leave type of that same company.
create or replace function public.leave_row_company()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  employee_org uuid;
  type_org uuid;
begin
  select organization_id into employee_org from public.employees where id = new.employee_id;
  if employee_org is null then
    raise exception 'Unknown employee for this row.' using errcode = '23503';
  end if;
  new.organization_id := employee_org;
  if new.leave_type_id is not null then
    select organization_id into type_org from public.leave_types where id = new.leave_type_id;
    if type_org is distinct from employee_org then
      raise exception 'This leave type belongs to another company.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists leave_balances_company on public.leave_balances;
create trigger leave_balances_company
before insert or update on public.leave_balances
for each row execute function public.leave_row_company();

drop trigger if exists leave_requests_company on public.leave_requests;
create trigger leave_requests_company
before insert or update on public.leave_requests
for each row execute function public.leave_row_company();

-- A company never changes once set; departments and managers must stay in
-- the same company; employees cannot change their own access fields.
create or replace function public.employees_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  department_org uuid;
begin
  if tg_op = 'UPDATE' then
    new.organization_id := old.organization_id;
    -- Signed-in employees who are not staff may only edit their own
    -- contact details (the service role, auth.uid() null, is trusted).
    if auth.uid() is not null and not public.is_org_staff() then
      new.role := old.role;
      new.status := old.status;
      new.email := old.email;
      new.department_id := old.department_id;
      new.start_date := old.start_date;
      new.monthly_leave_days := old.monthly_leave_days;
      new.job_title := old.job_title;
    end if;
  end if;
  if new.department_id is not null then
    select organization_id into department_org from public.departments where id = new.department_id;
    if department_org is distinct from new.organization_id then
      raise exception 'This department belongs to another company.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists employees_guard on public.employees;
create trigger employees_guard
before insert or update on public.employees
for each row execute function public.employees_guard();

create or replace function public.company_row_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  manager_org uuid;
begin
  if tg_op = 'UPDATE' then
    new.organization_id := old.organization_id;
  end if;
  -- Nested: PL/pgSQL may evaluate new.manager_id even when the table check
  -- is false, and leave_types / events have no such column.
  if tg_table_name = 'departments' then
    if new.manager_id is not null then
      select organization_id into manager_org from public.employees where id = new.manager_id;
      if manager_org is distinct from new.organization_id then
        raise exception 'This manager belongs to another company.' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists departments_guard on public.departments;
create trigger departments_guard
before insert or update on public.departments
for each row execute function public.company_row_guard();

drop trigger if exists leave_types_guard on public.leave_types;
create trigger leave_types_guard
before update on public.leave_types
for each row execute function public.company_row_guard();

drop trigger if exists events_guard on public.events;
create trigger events_guard
before update on public.events
for each row execute function public.company_row_guard();

-- ---------------------------------------------------------------------------
-- Row-level security: every rule is limited to the user's own company.
-- Earlier single-company policies on these tables are replaced.
-- ---------------------------------------------------------------------------

do $$
declare
  policy record;
begin
  for policy in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('organizations', 'employees', 'departments', 'leave_types',
                        'leave_balances', 'leave_requests', 'events')
  loop
    execute format('drop policy %I on %I.%I', policy.policyname, policy.schemaname, policy.tablename);
  end loop;
end;
$$;

alter table public.employees enable row level security;
alter table public.departments enable row level security;
alter table public.leave_types enable row level security;
alter table public.leave_balances enable row level security;
alter table public.leave_requests enable row level security;
alter table public.events enable row level security;

create policy "organizations: read own company" on public.organizations
  for select to authenticated using (id = public.current_org_id());
create policy "organizations: admins update their company" on public.organizations
  for update to authenticated
  using (id = public.current_org_id() and public.is_org_admin())
  with check (id = public.current_org_id());

create policy "employees: read colleagues" on public.employees
  for select to authenticated using (organization_id = public.current_org_id());
create policy "employees: staff add" on public.employees
  for insert to authenticated
  with check (organization_id = public.current_org_id() and public.is_org_staff());
create policy "employees: self or staff update" on public.employees
  for update to authenticated
  using (organization_id = public.current_org_id() and (id = auth.uid() or public.is_org_staff()))
  with check (organization_id = public.current_org_id());
create policy "employees: admins remove others" on public.employees
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin() and id <> auth.uid());

create policy "departments: read" on public.departments
  for select to authenticated using (organization_id = public.current_org_id());
create policy "departments: staff write" on public.departments
  for all to authenticated
  using (organization_id = public.current_org_id() and public.is_org_staff())
  with check (organization_id = public.current_org_id() and public.is_org_staff());

create policy "leave_types: read" on public.leave_types
  for select to authenticated using (organization_id = public.current_org_id());
create policy "leave_types: admins write" on public.leave_types
  for all to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin())
  with check (organization_id = public.current_org_id() and public.is_org_admin());

create policy "leave_balances: own or staff read" on public.leave_balances
  for select to authenticated
  using (organization_id = public.current_org_id() and (employee_id = auth.uid() or public.is_org_staff()));
create policy "leave_balances: staff write" on public.leave_balances
  for all to authenticated
  using (organization_id = public.current_org_id() and public.is_org_staff())
  with check (organization_id = public.current_org_id() and public.is_org_staff());

-- Everyone in the company sees requests (team calendar), as before.
create policy "leave_requests: read" on public.leave_requests
  for select to authenticated using (organization_id = public.current_org_id());
create policy "leave_requests: own pending or staff create" on public.leave_requests
  for insert to authenticated
  with check (
    organization_id = public.current_org_id()
    and (public.is_org_staff() or (employee_id = auth.uid() and status = 'pending'))
  );
create policy "leave_requests: own pending or staff update" on public.leave_requests
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and (public.is_org_staff() or (employee_id = auth.uid() and status = 'pending'))
  )
  with check (
    organization_id = public.current_org_id()
    and (public.is_org_staff() or (employee_id = auth.uid() and status = 'pending'))
  );
create policy "leave_requests: own pending or staff delete" on public.leave_requests
  for delete to authenticated
  using (
    organization_id = public.current_org_id()
    and (public.is_org_staff() or (employee_id = auth.uid() and status = 'pending'))
  );

create policy "events: read" on public.events
  for select to authenticated using (organization_id = public.current_org_id());
create policy "events: staff write" on public.events
  for all to authenticated
  using (organization_id = public.current_org_id() and public.is_org_staff())
  with check (organization_id = public.current_org_id() and public.is_org_staff());

-- ---------------------------------------------------------------------------
-- Default leave catalog for a new company
-- ---------------------------------------------------------------------------

create or replace function public.seed_organization_leave_types(p_org uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.leave_types (organization_id, name, code, default_days)
  select p_org, catalog.name, catalog.code, catalog.default_days
  from (
    values
      ('إجازة سنوية', 'VACATION', 21),
      ('إجازة مرضية', 'SICK', 10),
      ('إجازة أبوة / أمومة', 'PARENTAL', 0),
      ('Unpaid leave', 'UNPAID', 0),
      ('إجازة وفاة الزوج/الزوجة', 'EXCEPTIONAL_DEATH_SPOUSE', 3),
      ('إجازة وفاة أحد الوالدين أو أحد الأبناء', 'EXCEPTIONAL_DEATH_PARENT_CHILD', 3),
      ('إجازة وفاة أخ/أخت أو حفيد/حفيدة أو جد/جدة', 'EXCEPTIONAL_DEATH_OTHER', 2),
      ('إجازة زواج الموظّف', 'EXCEPTIONAL_MARRIAGE_EMPLOYEE', 3),
      ('إجازة زواج ابن/ابنة الموظّف', 'EXCEPTIONAL_MARRIAGE_CHILD', 1),
      ('إجازة ختان ابن الموظّف', 'EXCEPTIONAL_CIRCUMCISION', 1)
  ) as catalog (name, code, default_days)
  where not exists (
    select 1 from public.leave_types as existing
    where existing.organization_id = p_org and existing.code = catalog.code
  );
$$;

-- Creates a company with its leave catalog and makes an existing Auth user
-- its admin. Run from the SQL editor to set up a company by hand, e.g.
--   select public.create_organization('Acme', 'owner@acme.com');
create or replace function public.create_organization(p_name text, p_admin_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  org uuid;
  admin_user auth.users%rowtype;
begin
  select * into admin_user from auth.users where lower(email) = lower(trim(p_admin_email));
  if admin_user.id is null then
    raise exception 'No Auth user with email %. Create the user in Authentication → Users first.', p_admin_email;
  end if;
  if exists (select 1 from public.employees where id = admin_user.id) then
    raise exception 'User % already belongs to a company.', p_admin_email;
  end if;
  insert into public.organizations (name, slug)
  values (trim(p_name), public.organization_slug(p_name))
  returning id into org;
  perform public.seed_organization_leave_types(org);
  insert into public.employees (id, organization_id, full_name, email, role)
  values (
    admin_user.id,
    org,
    coalesce(admin_user.raw_user_meta_data->>'full_name', split_part(admin_user.email, '@', 1)),
    admin_user.email,
    'admin'
  );
  return org;
end;
$$;

revoke all on function public.create_organization(text, text) from public, anon, authenticated;
revoke all on function public.seed_organization_leave_types(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- New Auth users
-- ---------------------------------------------------------------------------
-- * Invited by an admin (invited_at is set only by the service role): joins
--   the company passed in the invite's organization_id, as an employee; the
--   invite flow then sets the role and details.
-- * Self sign-up with a company_name in the sign-up metadata: creates that
--   company and becomes its admin.
-- * Anything else gets no employee row, so the app signs the user out. A
--   sign-up can never join an existing company by itself.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  org uuid;
  invited_org uuid;
  company text := nullif(trim(new.raw_user_meta_data->>'company_name'), '');
  display_name text := coalesce(
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    split_part(new.email, '@', 1)
  );
begin
  if new.invited_at is not null then
    begin
      invited_org := (new.raw_user_meta_data->>'organization_id')::uuid;
    exception when invalid_text_representation then
      invited_org := null;
    end;
    if invited_org is not null and exists (select 1 from public.organizations where id = invited_org) then
      insert into public.employees (id, organization_id, full_name, email, role)
      values (new.id, invited_org, display_name, new.email, 'employee')
      on conflict (id) do nothing;
    end if;
    return new;
  end if;

  if company is not null then
    insert into public.organizations (name, slug)
    values (company, public.organization_slug(company))
    returning id into org;
    perform public.seed_organization_leave_types(org);
    insert into public.employees (id, organization_id, full_name, email, role)
    values (new.id, org, display_name, new.email, 'admin')
    on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
