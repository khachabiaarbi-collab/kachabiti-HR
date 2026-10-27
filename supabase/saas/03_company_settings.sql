-- RHFlow per-company settings (SaaS step 3).
--
-- Run in the Supabase SQL editor after 01_foundation.sql and the feature
-- scripts listed in SAAS.md. Safe to run again.
--
-- What it adds:
--   * on organizations: logo_url, brand_color (#rrggbb) and
--     monthly_leave_days (vacation days earned per month, default for new
--     employees);
--   * admins may change their company's name, logo, colour and leave rate,
--     never its status or slug (suspending a company is the service role's
--     job);
--   * new employees start with their company's leave rate;
--   * the public company-logos bucket (logos are uploaded by the app with the
--     service role, under <company id>/);
--   * an editable leave catalog (Settings → Leave Policy): admins add,
--     rename, change default days, deactivate and delete types. Built-in
--     types (codes VACATION, ANNUAL, SICK, PARENTAL, UNPAID) drive vacation
--     earning and payroll: they keep their code, stay active and cannot be
--     deleted. A type used by a leave request cannot be deleted either.
--
-- Employer details printed on payslips (address, matricule fiscal, CNSS
-- number) stay in payroll_company, per company since step 2.

do $$
begin
  if to_regprocedure('public.can_manage_employee(uuid)') is null then
    raise exception 'Run supabase/saas/01_foundation.sql first.';
  end if;
end;
$$;

alter table public.organizations
  add column if not exists logo_url text,
  add column if not exists brand_color text,
  add column if not exists monthly_leave_days numeric(6, 3) not null default 1.5;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.organizations'::regclass
      and conname = 'organizations_brand_color_check'
  ) then
    alter table public.organizations
      add constraint organizations_brand_color_check
      check (brand_color is null or brand_color ~ '^#[0-9a-f]{6}$');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.organizations'::regclass
      and conname = 'organizations_monthly_leave_days_check'
  ) then
    alter table public.organizations
      add constraint organizations_monthly_leave_days_check
      check (monthly_leave_days > 0 and monthly_leave_days <= 5);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.organizations'::regclass
      and conname = 'organizations_logo_url_check'
  ) then
    alter table public.organizations
      add constraint organizations_logo_url_check
      check (logo_url is null or (logo_url ~ '^https://' and char_length(logo_url) <= 1000));
  end if;
end;
$$;

-- Signed-in admins keep the company's id, slug, status and creation date.
create or replace function public.organizations_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.id := old.id;
    new.slug := old.slug;
    new.status := old.status;
    new.created_at := old.created_at;
  end if;
  new.name := trim(new.name);
  return new;
end;
$$;

drop trigger if exists organizations_guard on public.organizations;
create trigger organizations_guard
before update on public.organizations
for each row execute function public.organizations_guard();

-- New employees start with their company's leave rate unless one is given.
alter table public.employees alter column monthly_leave_days drop default;

create or replace function public.employees_company_leave_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.monthly_leave_days is null then
    select monthly_leave_days into new.monthly_leave_days
    from public.organizations where id = new.organization_id;
    new.monthly_leave_days := coalesce(new.monthly_leave_days, 1.5);
  end if;
  return new;
end;
$$;

drop trigger if exists employees_company_leave_rate on public.employees;
create trigger employees_company_leave_rate
before insert on public.employees
for each row execute function public.employees_company_leave_rate();

revoke all on function public.organizations_guard() from public, anon, authenticated;
revoke all on function public.employees_company_leave_rate() from public, anon, authenticated;

-- Company logos: public images, written only by the service role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'company-logos',
  'company-logos',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Leave catalog per company
-- ---------------------------------------------------------------------------

-- Inactive types stay on past requests and balances but cannot be requested.
alter table public.leave_types
  add column if not exists active boolean not null default true;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.leave_types'::regclass
      and conname = 'leave_types_name_length_check'
  ) then
    alter table public.leave_types
      add constraint leave_types_name_length_check
      check (char_length(trim(name)) between 1 and 80) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.leave_types'::regclass
      and conname = 'leave_types_default_days_check'
  ) then
    alter table public.leave_types
      add constraint leave_types_default_days_check
      check (default_days between 0 and 365) not valid;
  end if;
end;
$$;

create or replace function public.leave_types_policy_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  built_in boolean := tg_op <> 'INSERT'
    and upper(coalesce(old.code, '')) in ('VACATION', 'ANNUAL', 'SICK', 'PARENTAL', 'UNPAID');
begin
  if tg_op = 'DELETE' then
    if built_in then
      raise exception 'LEAVE_TYPE_BUILT_IN' using errcode = '42501';
    end if;
    if exists (select 1 from public.leave_requests where leave_type_id = old.id) then
      raise exception 'LEAVE_TYPE_IN_USE' using errcode = '23503';
    end if;
    return old;
  end if;

  new.name := trim(new.name);
  if built_in then
    new.code := old.code;
    new.active := true;
  end if;
  return new;
end;
$$;

drop trigger if exists leave_types_policy_guard on public.leave_types;
create trigger leave_types_policy_guard
before insert or update or delete on public.leave_types
for each row execute function public.leave_types_policy_guard();

revoke all on function public.leave_types_policy_guard() from public, anon, authenticated;
