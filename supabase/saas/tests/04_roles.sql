-- Role checks for SaaS step 4 (owner, admin, hr, manager, employee).
--
-- Run in the SQL editor of a development project (never production) after
-- every script listed in SAAS.md. Everything happens in one transaction that
-- is rolled back at the end.
-- Success: the last statement returns "All step 4 role checks passed".
-- Failure: the run stops with "ROLES FAILED: …".
--
-- Company A: a001 owner, a002 admin, a003 hr, a004 manager of "A Sales",
-- a005 employee in A Sales, a006 employee outside it. Company B: b001 owner,
-- b002 employee.

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000a001', 'owner@a.test', '{"full_name":"Owner A","company_name":"Roles Company A"}'),
  ('00000000-0000-4000-8000-00000000b001', 'owner@b.test', '{"full_name":"Owner B","company_name":"Roles Company B"}');

insert into auth.users (id, email, raw_user_meta_data, invited_at)
select person.id, person.email,
       jsonb_build_object('full_name', person.full_name, 'organization_id', owner.organization_id), now()
from (values
  ('00000000-0000-4000-8000-00000000a002'::uuid, 'admin@a.test', 'Admin A', '00000000-0000-4000-8000-00000000a001'::uuid),
  ('00000000-0000-4000-8000-00000000a003'::uuid, 'hr@a.test', 'HR A', '00000000-0000-4000-8000-00000000a001'::uuid),
  ('00000000-0000-4000-8000-00000000a004'::uuid, 'manager@a.test', 'Manager A', '00000000-0000-4000-8000-00000000a001'::uuid),
  ('00000000-0000-4000-8000-00000000a005'::uuid, 'team@a.test', 'Team member A', '00000000-0000-4000-8000-00000000a001'::uuid),
  ('00000000-0000-4000-8000-00000000a006'::uuid, 'other@a.test', 'Other employee A', '00000000-0000-4000-8000-00000000a001'::uuid),
  ('00000000-0000-4000-8000-00000000b002'::uuid, 'employee@b.test', 'Employee B', '00000000-0000-4000-8000-00000000b001'::uuid)
) as person (id, email, full_name, owner_id)
join public.employees owner on owner.id = person.owner_id;

-- Roles and the team, set as the service role would (invite flow).
update public.employees set role = 'admin' where id = '00000000-0000-4000-8000-00000000a002';
update public.employees set role = 'hr' where id = '00000000-0000-4000-8000-00000000a003';
update public.employees set role = 'manager' where id = '00000000-0000-4000-8000-00000000a004';
insert into public.departments (organization_id, name, manager_id)
select organization_id, 'A Sales', '00000000-0000-4000-8000-00000000a004'
from public.employees where id = '00000000-0000-4000-8000-00000000a001';
update public.employees
set department_id = (select id from public.departments where name = 'A Sales')
where id = '00000000-0000-4000-8000-00000000a005';

-- Requests, balances and punches for both A employees.
insert into public.leave_requests (employee_id, leave_type_id, start_date, end_date, status)
select person.id, leave_type.id, current_date, current_date, 'pending'
from public.employees person
join public.leave_types leave_type
  on leave_type.organization_id = person.organization_id and leave_type.code = 'SICK'
where person.id in ('00000000-0000-4000-8000-00000000a005', '00000000-0000-4000-8000-00000000a006');
insert into public.leave_balances (employee_id, leave_type_id, days_remaining)
select person.id, leave_type.id, 10
from public.employees person
join public.leave_types leave_type
  on leave_type.organization_id = person.organization_id and leave_type.code = 'SICK'
where person.id in ('00000000-0000-4000-8000-00000000a005', '00000000-0000-4000-8000-00000000a006')
on conflict (employee_id, leave_type_id) do update set days_remaining = 10;
insert into public.attendance_punches (employee_id, work_date, type, occurred_at, sequence_no)
values
  ('00000000-0000-4000-8000-00000000a005', date '2026-10-01', 'entry', timestamptz '2026-10-01 08:00:00+01', 1),
  ('00000000-0000-4000-8000-00000000a006', date '2026-10-01', 'entry', timestamptz '2026-10-01 08:00:00+01', 1);
insert into public.authorizations (employee_id, date, start_time, end_time, duration_minutes, reason)
values
  ('00000000-0000-4000-8000-00000000a005', date '2026-10-02', '09:00', '10:00', 60, 'Team'),
  ('00000000-0000-4000-8000-00000000a006', date '2026-10-02', '09:00', '10:00', 60, 'Other');

do $$
begin
  -- One owner per company.
  begin
    update public.employees set role = 'owner' where id = '00000000-0000-4000-8000-00000000a002';
    raise exception 'ROLES FAILED: a company got a second owner';
  exception when unique_violation then
    null;
  end;

  -- Notices: the manager hears about their team only; hr about everyone.
  if not exists (
    select 1 from public.notifications notice
    join public.authorizations request on request.id = notice.authorization_id
    where notice.user_id = '00000000-0000-4000-8000-00000000a004'
      and request.employee_id = '00000000-0000-4000-8000-00000000a005'
  ) then
    raise exception 'ROLES FAILED: the manager was not told about their team''s request';
  end if;
  if exists (
    select 1 from public.notifications notice
    join public.authorizations request on request.id = notice.authorization_id
    where notice.user_id = '00000000-0000-4000-8000-00000000a004'
      and request.employee_id = '00000000-0000-4000-8000-00000000a006'
  ) then
    raise exception 'ROLES FAILED: the manager was told about someone outside their team';
  end if;
  if (
    select count(*) from public.notifications notice
    join public.authorizations request on request.id = notice.authorization_id
    where notice.user_id = '00000000-0000-4000-8000-00000000a003'
  ) <> 2 then
    raise exception 'ROLES FAILED: hr was not told about every request';
  end if;
end;
$$;

set local role authenticated;

-- --- Manager -----------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a004","role":"authenticated"}', true);

do $$
declare
  changed integer;
  report jsonb;
begin
  if not public.can_manage_employee('00000000-0000-4000-8000-00000000a005')
     or public.can_manage_employee('00000000-0000-4000-8000-00000000a006')
     or public.can_manage_employee('00000000-0000-4000-8000-00000000a004')
     or public.can_manage_employee('00000000-0000-4000-8000-00000000b002') then
    raise exception 'ROLES FAILED: the manager''s team is wrong';
  end if;

  update public.leave_requests set status = 'approved', approver_id = auth.uid()
  where employee_id = '00000000-0000-4000-8000-00000000a005';
  get diagnostics changed = row_count;
  if changed <> 1 then
    raise exception 'ROLES FAILED: the manager could not approve their team''s leave';
  end if;
  update public.leave_balances set days_remaining = 9
  where employee_id = '00000000-0000-4000-8000-00000000a005';
  get diagnostics changed = row_count;
  if changed <> 1 then
    raise exception 'ROLES FAILED: approving could not deduct the team member''s balance';
  end if;

  update public.leave_requests set status = 'approved', approver_id = auth.uid()
  where employee_id = '00000000-0000-4000-8000-00000000a006';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ROLES FAILED: the manager approved leave outside their team';
  end if;

  if exists (select 1 from public.leave_balances where employee_id = '00000000-0000-4000-8000-00000000a006')
     or exists (select 1 from public.authorizations where employee_id = '00000000-0000-4000-8000-00000000a006')
     or exists (select 1 from public.attendance_punches where employee_id = '00000000-0000-4000-8000-00000000a006') then
    raise exception 'ROLES FAILED: the manager sees data outside their team';
  end if;
  if not exists (select 1 from public.authorizations where employee_id = '00000000-0000-4000-8000-00000000a005') then
    raise exception 'ROLES FAILED: the manager cannot see their team''s authorizations';
  end if;

  report := public.attendance_report(date '2026-10-01', date '2026-10-01');
  if (report ->> 'total')::integer <> 1
     or report -> 'items' -> 0 ->> 'employeeId' <> '00000000-0000-4000-8000-00000000a005' then
    raise exception 'ROLES FAILED: the manager''s attendance report is not limited to their team';
  end if;

  begin
    perform public.attendance_day_summary(
      '00000000-0000-4000-8000-00000000a006', date '2026-10-01', clock_timestamp());
    raise exception 'ROLES FAILED: the manager read attendance outside their team';
  exception when raise_exception then
    if sqlerrm <> 'FORBIDDEN' then raise; end if;
  end;

  update public.employees set job_title = 'Changed by manager'
  where id = '00000000-0000-4000-8000-00000000a005';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ROLES FAILED: the manager edited an employee record';
  end if;

  begin
    insert into public.departments (name) values ('Planted by manager');
    raise exception 'ROLES FAILED: the manager created a department';
  exception when insufficient_privilege then
    null;
  end;

  if exists (select 1 from public.payroll_settings) or exists (select 1 from public.pay_components) then
    raise exception 'ROLES FAILED: the manager sees payroll';
  end if;
end;
$$;

-- --- HR ------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a003","role":"authenticated"}', true);

do $$
declare
  changed integer;
begin
  if not public.can_manage_employee('00000000-0000-4000-8000-00000000a006')
     or public.can_manage_employee('00000000-0000-4000-8000-00000000b002') then
    raise exception 'ROLES FAILED: hr does not manage exactly their company';
  end if;
  if not exists (select 1 from public.payroll_settings) then
    raise exception 'ROLES FAILED: hr cannot see payroll';
  end if;

  update public.employees set job_title = 'Sales rep'
  where id = '00000000-0000-4000-8000-00000000a006';
  get diagnostics changed = row_count;
  if changed <> 1 then
    raise exception 'ROLES FAILED: hr could not edit an employee record';
  end if;

  begin
    update public.employees set role = 'manager' where id = '00000000-0000-4000-8000-00000000a006';
    raise exception 'ROLES FAILED: hr changed a role';
  exception when insufficient_privilege then
    if sqlerrm <> 'ROLE_NOT_ALLOWED' then raise; end if;
  end;
  begin
    update public.employees set status = 'inactive' where id = '00000000-0000-4000-8000-00000000a002';
    raise exception 'ROLES FAILED: hr deactivated an admin';
  exception when insufficient_privilege then
    if sqlerrm <> 'ROLE_NOT_ALLOWED' then raise; end if;
  end;

  insert into public.leave_types (name, default_days, code) values ('HR training', 2, 'CUSTOM_HRTEST01');

  update public.organizations set name = 'Renamed by hr';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ROLES FAILED: hr changed the company profile';
  end if;
end;
$$;

-- --- Admin -------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);

do $$
declare
  changed integer;
begin
  update public.employees set role = 'hr' where id = '00000000-0000-4000-8000-00000000a006';
  if (select role from public.employees where id = '00000000-0000-4000-8000-00000000a006') <> 'hr' then
    raise exception 'ROLES FAILED: an admin could not give the hr role';
  end if;
  update public.employees set role = 'employee' where id = '00000000-0000-4000-8000-00000000a006';

  begin
    update public.employees set role = 'admin' where id = '00000000-0000-4000-8000-00000000a006';
    raise exception 'ROLES FAILED: an admin made someone admin';
  exception when insufficient_privilege then
    if sqlerrm <> 'ROLE_NOT_ALLOWED' then raise; end if;
  end;
  begin
    update public.employees set role = 'admin' where id = '00000000-0000-4000-8000-00000000a001';
    raise exception 'ROLES FAILED: an admin demoted the owner';
  exception when insufficient_privilege then
    if sqlerrm <> 'OWNER_TRANSFER_ONLY' then raise; end if;
  end;
  begin
    update public.employees set status = 'inactive' where id = '00000000-0000-4000-8000-00000000a001';
    raise exception 'ROLES FAILED: an admin deactivated the owner';
  exception when insufficient_privilege then
    if sqlerrm <> 'OWNER_CANNOT_BE_DEACTIVATED' then raise; end if;
  end;

  delete from public.employees where id = '00000000-0000-4000-8000-00000000a001';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ROLES FAILED: an admin deleted the owner';
  end if;

  begin
    perform public.transfer_ownership('00000000-0000-4000-8000-00000000a002');
    raise exception 'ROLES FAILED: an admin transferred ownership';
  exception when insufficient_privilege then
    if sqlerrm <> 'OWNER_ONLY' then raise; end if;
  end;
end;
$$;

-- --- Employee ----------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a006","role":"authenticated"}', true);

do $$
begin
  update public.employees set role = 'owner', job_title = 'CEO'
  where id = auth.uid();
  if (select role from public.employees where id = auth.uid()) <> 'employee' then
    raise exception 'ROLES FAILED: an employee changed their own role';
  end if;
end;
$$;

-- --- Owner -------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);

do $$
begin
  begin
    perform public.transfer_ownership('00000000-0000-4000-8000-00000000a005');
    raise exception 'ROLES FAILED: ownership went to someone who is not an admin';
  exception when invalid_parameter_value then
    null;
  end;

  update public.employees set role = 'admin' where id = '00000000-0000-4000-8000-00000000a006';
  if (select role from public.employees where id = '00000000-0000-4000-8000-00000000a006') <> 'admin' then
    raise exception 'ROLES FAILED: the owner could not make someone admin';
  end if;

  perform public.transfer_ownership('00000000-0000-4000-8000-00000000a002');
  if (select role from public.employees where id = '00000000-0000-4000-8000-00000000a002') <> 'owner'
     or (select role from public.employees where id = '00000000-0000-4000-8000-00000000a001') <> 'admin' then
    raise exception 'ROLES FAILED: ownership was not transferred';
  end if;
  if (select count(*) from public.employees where role = 'owner') <> 1 then
    raise exception 'ROLES FAILED: the company does not have exactly one owner';
  end if;
end;
$$;

reset role;

select 'All step 4 role checks passed' as result;

rollback;
