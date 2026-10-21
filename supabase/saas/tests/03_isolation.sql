-- Checks for SaaS step 3 (supabase/saas/03_company_settings.sql).
--
-- Run in the SQL editor of a development project (never production) after
-- 03_company_settings.sql. Everything happens in one transaction that is
-- rolled back at the end.
-- Success: the last statement returns "All step 3 checks passed".
-- Failure: the run stops with "ISOLATION FAILED: …".

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000a001', 'admin@a.test', '{"full_name":"Admin A","company_name":"Test Company A"}'),
  ('00000000-0000-4000-8000-00000000b001', 'admin@b.test', '{"full_name":"Admin B","company_name":"Test Company B"}');
insert into auth.users (id, email, raw_user_meta_data, invited_at)
select '00000000-0000-4000-8000-00000000a002', 'employee@a.test',
       jsonb_build_object('full_name', 'Employee A', 'organization_id', organization_id), now()
from public.employees where id = '00000000-0000-4000-8000-00000000a001';

select
  set_config('isolation.org_a', (select organization_id::text from public.employees
    where id = '00000000-0000-4000-8000-00000000a001'), true),
  set_config('isolation.org_b', (select organization_id::text from public.employees
    where id = '00000000-0000-4000-8000-00000000b001'), true);

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
  update public.organizations
  set name = '  A Renamed  ', brand_color = '#0f766e', monthly_leave_days = 2,
      logo_url = 'https://example.test/logo.png',
      status = 'suspended', slug = 'taken-over'
  where id = org_a;
  if (select name from public.organizations where id = org_a) <> 'A Renamed' then
    raise exception 'ISOLATION FAILED: admin A could not rename their company';
  end if;
  if (select brand_color from public.organizations where id = org_a) <> '#0f766e'
     or (select monthly_leave_days from public.organizations where id = org_a) <> 2 then
    raise exception 'ISOLATION FAILED: admin A could not save colour or leave rate';
  end if;
  if (select status from public.organizations where id = org_a) <> 'active'
     or (select slug from public.organizations where id = org_a) = 'taken-over' then
    raise exception 'ISOLATION FAILED: admin A changed their company status or slug';
  end if;

  update public.organizations set name = 'Hacked' where id = org_b;
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ISOLATION FAILED: admin A changed company B';
  end if;

  begin
    update public.organizations set brand_color = 'red' where id = org_a;
    raise exception 'ISOLATION FAILED: an invalid colour was saved';
  exception when check_violation then
    null;
  end;
end;
$$;

-- Leave catalog, still as admin A.
do $$
declare
  org_a uuid := current_setting('isolation.org_a')::uuid;
  org_b uuid := current_setting('isolation.org_b')::uuid;
  vacation uuid;
  custom uuid;
  spare uuid;
  changed integer;
begin
  select id into vacation from public.leave_types where code = 'VACATION';

  update public.leave_types
  set name = '  Congé payé  ', default_days = 24, active = false, code = 'HIJACKED'
  where id = vacation;
  if (select name from public.leave_types where id = vacation) <> 'Congé payé'
     or (select default_days from public.leave_types where id = vacation) <> 24 then
    raise exception 'ISOLATION FAILED: admin A could not rename the vacation type';
  end if;
  if (select code from public.leave_types where id = vacation) <> 'VACATION'
     or not (select active from public.leave_types where id = vacation) then
    raise exception 'ISOLATION FAILED: a built-in type lost its code or was deactivated';
  end if;

  begin
    delete from public.leave_types where id = vacation;
    raise exception 'ISOLATION FAILED: a built-in leave type was deleted';
  exception when insufficient_privilege then
    if sqlerrm <> 'LEAVE_TYPE_BUILT_IN' then raise; end if;
  end;

  insert into public.leave_types (name, default_days, code)
  values ('Training', 5, 'CUSTOM_TRAIN001') returning id into custom;
  if (select organization_id from public.leave_types where id = custom) is distinct from org_a then
    raise exception 'ISOLATION FAILED: a new leave type did not get company A';
  end if;

  insert into public.leave_requests (employee_id, leave_type_id, start_date, end_date, status)
  values ('00000000-0000-4000-8000-00000000a002', custom, current_date, current_date, 'pending');
  begin
    delete from public.leave_types where id = custom;
    raise exception 'ISOLATION FAILED: a leave type used by a request was deleted';
  exception when foreign_key_violation then
    if sqlerrm <> 'LEAVE_TYPE_IN_USE' then raise; end if;
  end;

  insert into public.leave_types (name, default_days, code)
  values ('Spare', 1, 'CUSTOM_SPARE001') returning id into spare;
  delete from public.leave_types where id = spare;
  if exists (select 1 from public.leave_types where id = spare) then
    raise exception 'ISOLATION FAILED: an unused custom leave type could not be deleted';
  end if;

  update public.leave_types set name = 'Hacked' where organization_id = org_b;
  get diagnostics changed = row_count;
  delete from public.leave_types where organization_id = org_b and code not in ('VACATION', 'SICK', 'PARENTAL', 'UNPAID');
  if changed <> 0 or exists (
    select 1 from public.leave_types where organization_id = org_b
  ) then
    raise exception 'ISOLATION FAILED: admin A changed or sees company B leave types';
  end if;
end;
$$;

-- --- As an ordinary employee of company A ----------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);

do $$
declare
  changed integer;
begin
  update public.organizations set name = 'Employee was here'
  where id = current_setting('isolation.org_a')::uuid;
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ISOLATION FAILED: an employee changed the company profile';
  end if;

  begin
    insert into public.leave_types (name, default_days) values ('Free days', 99);
    raise exception 'ISOLATION FAILED: an employee added a leave type';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- A new hire starts with the company's rate (2 since the update above).
insert into auth.users (id, email, raw_user_meta_data, invited_at)
values ('00000000-0000-4000-8000-00000000a003', 'hire@a.test',
        jsonb_build_object('full_name', 'New hire', 'organization_id', current_setting('isolation.org_a')), now());

do $$
begin
  if (select monthly_leave_days from public.employees
      where id = '00000000-0000-4000-8000-00000000a003') <> 2 then
    raise exception 'ISOLATION FAILED: a new employee did not get the company leave rate';
  end if;
  if (select monthly_leave_days from public.employees
      where id = '00000000-0000-4000-8000-00000000b001') <> 1.5 then
    raise exception 'ISOLATION FAILED: a company B employee did not get the default rate';
  end if;
  if (select count(*) from public.leave_types
      where organization_id = current_setting('isolation.org_b')::uuid) < 9 then
    raise exception 'ISOLATION FAILED: company A removed company B leave types';
  end if;
end;
$$;

select 'All step 3 checks passed' as result;

rollback;
