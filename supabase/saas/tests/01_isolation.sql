-- Company isolation checks for supabase/saas/01_foundation.sql.
--
-- Run in the SQL editor of a development project (never production) after
-- the foundation script. Everything happens in one transaction that is
-- rolled back at the end: no test company or user is kept.
-- Success: the last statement returns "All isolation checks passed".
-- Failure: the run stops with "ISOLATION FAILED: …".
--
-- The two test company ids are kept in transaction settings
-- (isolation.org_a / isolation.org_b), readable under any role.

begin;

-- Two companies created by self sign-up, one invited employee in company A,
-- and two sign-ups that must not get into any company.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000a001', 'admin@a.test', '{"full_name":"Admin A","company_name":"Test Company A"}'),
  ('00000000-0000-4000-8000-00000000b001', 'admin@b.test', '{"full_name":"Admin B","company_name":"Test Company B"}');

insert into auth.users (id, email, raw_user_meta_data, invited_at)
select '00000000-0000-4000-8000-00000000a002', 'employee@a.test',
       jsonb_build_object('full_name', 'Employee A', 'organization_id', organization_id), now()
from public.employees where id = '00000000-0000-4000-8000-00000000a001';

-- Not invited, no company name: no employee row.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000c1', 'nobody@c.test', '{"full_name":"Nobody"}');

-- Claims to belong to company B without an invite: must be ignored.
insert into auth.users (id, email, raw_user_meta_data)
select '00000000-0000-4000-8000-0000000000c2', 'intruder@c.test',
       jsonb_build_object('organization_id', organization_id)
from public.employees where id = '00000000-0000-4000-8000-00000000b001';

select
  set_config('isolation.org_a', coalesce((select organization_id::text from public.employees
    where id = '00000000-0000-4000-8000-00000000a001'), ''), true),
  set_config('isolation.org_b', coalesce((select organization_id::text from public.employees
    where id = '00000000-0000-4000-8000-00000000b001'), ''), true);

do $$
declare
  org_a uuid := nullif(current_setting('isolation.org_a'), '')::uuid;
  org_b uuid := nullif(current_setting('isolation.org_b'), '')::uuid;
begin
  if org_a is null or org_b is null or org_a = org_b then
    raise exception 'ISOLATION FAILED: sign-up did not create two separate companies';
  end if;
  if (select role from public.employees where id = '00000000-0000-4000-8000-00000000a001') <> 'owner' then
    raise exception 'ISOLATION FAILED: the sign-up user is not owner of their company';
  end if;
  if (select organization_id from public.employees where id = '00000000-0000-4000-8000-00000000a002') is distinct from org_a then
    raise exception 'ISOLATION FAILED: the invited employee did not join company A';
  end if;
  if exists (select 1 from public.employees where id in (
      '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c2')) then
    raise exception 'ISOLATION FAILED: a user joined a company without an invite';
  end if;
  if (select count(*) from public.leave_types where organization_id = org_a) < 9 then
    raise exception 'ISOLATION FAILED: company A did not get its leave catalog';
  end if;
end;
$$;

-- Data for company B, created as B's admin would.
insert into public.departments (organization_id, name)
values (current_setting('isolation.org_b')::uuid, 'B Sales');
insert into public.events (organization_id, title, start_date, end_date)
values (current_setting('isolation.org_b')::uuid, 'B party', current_date, current_date);
insert into public.leave_balances (employee_id, leave_type_id, days_remaining)
select '00000000-0000-4000-8000-00000000b001', id, 21
from public.leave_types
where organization_id = current_setting('isolation.org_b')::uuid and code = 'VACATION';

-- --- As the admin of company A ---------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);

do $$
declare
  org_a uuid := current_setting('isolation.org_a')::uuid;
  org_b uuid := current_setting('isolation.org_b')::uuid;
  changed integer;
begin
  if (select count(*) from public.employees) <> 2 then
    raise exception 'ISOLATION FAILED: admin A sees % employees, expected 2', (select count(*) from public.employees);
  end if;
  if exists (select 1 from public.organizations where id = org_b) then
    raise exception 'ISOLATION FAILED: admin A can read company B';
  end if;
  if exists (select 1 from public.departments) or exists (select 1 from public.events) then
    raise exception 'ISOLATION FAILED: admin A sees company B departments or events';
  end if;
  if exists (select 1 from public.leave_types where organization_id = org_b) then
    raise exception 'ISOLATION FAILED: admin A sees company B leave types';
  end if;

  update public.employees set job_title = 'hacked'
  where id = '00000000-0000-4000-8000-00000000b001';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ISOLATION FAILED: admin A changed an employee of company B';
  end if;

  delete from public.employees where id = '00000000-0000-4000-8000-00000000b001';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ISOLATION FAILED: admin A deleted an employee of company B';
  end if;

  if exists (select 1 from public.leave_balances where organization_id = org_b) then
    raise exception 'ISOLATION FAILED: admin A sees company B balances';
  end if;

  begin
    insert into public.departments (organization_id, name) values (org_b, 'Planted in B');
    raise exception 'ISOLATION FAILED: admin A created a department in company B';
  exception when insufficient_privilege then
    null; -- refused by RLS, as expected
  end;

  insert into public.departments (name) values ('A Sales');
  if (select organization_id from public.departments where name = 'A Sales') is distinct from org_a then
    raise exception 'ISOLATION FAILED: a new department did not get company A automatically';
  end if;

  -- Editing company rows works (guard triggers on events and leave types).
  insert into public.events (title, start_date, end_date) values ('A party', current_date, current_date);
  update public.events set title = 'A party (moved)' where title = 'A party';
  update public.leave_types set default_days = default_days where organization_id = org_a;
  if not exists (select 1 from public.events where title = 'A party (moved)') then
    raise exception 'ISOLATION FAILED: admin A could not edit their own event';
  end if;

  update public.employees set organization_id = org_b
  where id = '00000000-0000-4000-8000-00000000a002';
  if (select organization_id from public.employees where id = '00000000-0000-4000-8000-00000000a002') is distinct from org_a then
    raise exception 'ISOLATION FAILED: an employee was moved to another company';
  end if;
end;
$$;

-- --- As an ordinary employee of company A ----------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);

do $$
declare
  org_a uuid := current_setting('isolation.org_a')::uuid;
  a_type uuid;
begin
  update public.employees set role = 'admin', status = 'active', phone = '+216 00 000 000'
  where id = auth.uid();
  if (select role from public.employees where id = auth.uid()) <> 'employee' then
    raise exception 'ISOLATION FAILED: an employee made themselves admin';
  end if;
  if (select phone from public.employees where id = auth.uid()) is distinct from '+216 00 000 000' then
    raise exception 'ISOLATION FAILED: an employee cannot update their own phone';
  end if;

  if exists (select 1 from public.leave_balances where employee_id <> auth.uid()) then
    raise exception 'ISOLATION FAILED: an employee sees other people''s balances';
  end if;

  select id into a_type from public.leave_types where code = 'VACATION';
  insert into public.leave_requests (employee_id, leave_type_id, start_date, end_date, status)
  values (auth.uid(), a_type, current_date, current_date, 'pending');
  if (select organization_id from public.leave_requests where employee_id = auth.uid()) is distinct from org_a then
    raise exception 'ISOLATION FAILED: a leave request did not get company A';
  end if;

  begin
    insert into public.leave_requests (employee_id, leave_type_id, start_date, end_date, status)
    values (auth.uid(), a_type, current_date, current_date, 'approved');
    raise exception 'ISOLATION FAILED: an employee approved their own request';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- A leave type of company B cannot be used for an employee of company A.
do $$
declare
  b_type uuid;
begin
  select id into b_type from public.leave_types
  where organization_id = current_setting('isolation.org_b')::uuid and code = 'VACATION';
  begin
    insert into public.leave_balances (employee_id, leave_type_id, days_remaining)
    values ('00000000-0000-4000-8000-00000000a002', b_type, 5);
    raise exception 'ISOLATION FAILED: a company B leave type was given to a company A employee';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

select 'All isolation checks passed' as result;

rollback;
