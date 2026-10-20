-- Company isolation checks for SaaS step 2: authorizations, attendance,
-- leave accrual, payroll, notifications, work locations and leave
-- attachments.
--
-- Run in the SQL editor of a development project (never production) after
-- every script listed in SAAS.md. Everything happens in one transaction that
-- is rolled back at the end: no test company or user is kept.
-- Success: the last statement returns "All step 2 isolation checks passed".
-- Failure: the run stops with "ISOLATION FAILED: …".
--
-- The test company ids are kept in transaction settings
-- (isolation.org_a / isolation.org_b), readable under any role.

begin;

-- Companies A and B by self sign-up, one invited employee in each.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000a001', 'admin@a.test', '{"full_name":"Admin A","company_name":"Test Company A"}'),
  ('00000000-0000-4000-8000-00000000b001', 'admin@b.test', '{"full_name":"Admin B","company_name":"Test Company B"}');

insert into auth.users (id, email, raw_user_meta_data, invited_at)
select '00000000-0000-4000-8000-00000000a002', 'employee@a.test',
       jsonb_build_object('full_name', 'Employee A', 'organization_id', organization_id), now()
from public.employees where id = '00000000-0000-4000-8000-00000000a001';
insert into auth.users (id, email, raw_user_meta_data, invited_at)
select '00000000-0000-4000-8000-00000000b002', 'employee@b.test',
       jsonb_build_object('full_name', 'Employee B', 'organization_id', organization_id), now()
from public.employees where id = '00000000-0000-4000-8000-00000000b001';

select
  set_config('isolation.org_a', (select organization_id::text from public.employees
    where id = '00000000-0000-4000-8000-00000000a001'), true),
  set_config('isolation.org_b', (select organization_id::text from public.employees
    where id = '00000000-0000-4000-8000-00000000b001'), true);

-- Every new company gets its own starting data.
do $$
declare
  org uuid;
begin
  foreach org in array array[
    current_setting('isolation.org_a')::uuid,
    current_setting('isolation.org_b')::uuid
  ] loop
    if not exists (select 1 from public.attendance_settings where organization_id = org) then
      raise exception 'ISOLATION FAILED: a new company has no attendance settings';
    end if;
    if (select count(*) from public.work_schedules where organization_id = org and is_default) <> 1 then
      raise exception 'ISOLATION FAILED: a new company has no default work schedule';
    end if;
    if (select count(*) from public.pay_components where organization_id = org) < 5 then
      raise exception 'ISOLATION FAILED: a new company has no pay components';
    end if;
    if not exists (select 1 from public.payroll_settings where organization_id = org and year = 2026) then
      raise exception 'ISOLATION FAILED: a new company has no 2026 payroll rates';
    end if;
    if (select company.name from public.payroll_company company where company.organization_id = org)
       is distinct from (select organization.name from public.organizations organization where organization.id = org) then
      raise exception 'ISOLATION FAILED: employer details do not carry the company name';
    end if;
  end loop;
end;
$$;

-- Company B data, written as the service role would.
insert into public.attendance_punches (employee_id, work_date, type, occurred_at, sequence_no)
values ('00000000-0000-4000-8000-00000000b002', date '2026-10-01', 'entry',
        timestamptz '2026-10-01 08:00:00+01', 1);
insert into public.attendance_correction_requests
  (requester_id, employee_id, work_date, operation, proposed_type, proposed_occurred_at, reason)
values ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002',
        date '2026-10-01', 'add', 'exit', timestamptz '2026-10-01 17:00:00+01', 'Forgot to punch out');
insert into public.authorizations (employee_id, date, start_time, end_time, duration_minutes, reason)
values ('00000000-0000-4000-8000-00000000b002', date '2026-10-02', '09:00', '10:00', 60, 'Doctor');
insert into public.authorizations (employee_id, date, start_time, end_time, duration_minutes, reason)
values ('00000000-0000-4000-8000-00000000a002', date '2026-10-02', '09:00', '10:00', 60, 'Bank');
insert into public.work_locations (organization_id, name, latitude, longitude)
values (current_setting('isolation.org_b')::uuid, 'B office', 36.8, 10.18);
insert into public.employee_contracts (employee_id, effective_from, base_salary)
values ('00000000-0000-4000-8000-00000000b002', date '2026-01-01', 1500);
insert into public.payroll_runs (organization_id, period)
values (current_setting('isolation.org_b')::uuid, date '2026-09-01');
insert into public.payslips (run_id, employee_id, period, net)
select id, '00000000-0000-4000-8000-00000000b002', period, 1200
from public.payroll_runs where organization_id = current_setting('isolation.org_b')::uuid;
insert into storage.objects (bucket_id, name)
values ('leave-attachments', '00000000-0000-4000-8000-00000000b002/sick-note.pdf');

-- Staff are only told about their own company's requests.
do $$
begin
  if exists (
    select 1 from public.notifications
    where user_id = '00000000-0000-4000-8000-00000000a001'
      and (authorization_id in (select id from public.authorizations
             where employee_id = '00000000-0000-4000-8000-00000000b002')
        or attendance_correction_id is not null)
  ) then
    raise exception 'ISOLATION FAILED: admin A was notified of a company B request';
  end if;
  if exists (
    select 1 from public.notifications
    where user_id = '00000000-0000-4000-8000-00000000b001'
      and authorization_id in (select id from public.authorizations
        where employee_id = '00000000-0000-4000-8000-00000000a002')
  ) then
    raise exception 'ISOLATION FAILED: admin B was notified of a company A request';
  end if;
  if not exists (
    select 1 from public.notifications
    where user_id = '00000000-0000-4000-8000-00000000b001'
      and authorization_id in (select id from public.authorizations
        where employee_id = '00000000-0000-4000-8000-00000000b002')
  ) then
    raise exception 'ISOLATION FAILED: admin B was not notified of their own employee''s request';
  end if;
end;
$$;

-- --- As the admin of company A ---------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);

do $$
declare
  org_a uuid := current_setting('isolation.org_a')::uuid;
  org_b uuid := current_setting('isolation.org_b')::uuid;
  b_correction uuid;
  b_schedule uuid;
  report jsonb;
begin
  -- Tables
  if exists (select 1 from public.authorizations where employee_id = '00000000-0000-4000-8000-00000000b002') then
    raise exception 'ISOLATION FAILED: admin A sees company B authorizations';
  end if;
  if exists (select 1 from public.attendance_punches)
     or exists (select 1 from public.attendance_correction_requests) then
    raise exception 'ISOLATION FAILED: admin A sees company B punches or corrections';
  end if;
  if (select count(*) from public.attendance_settings) <> 1
     or exists (select 1 from public.work_schedules where organization_id <> org_a)
     or exists (
       select 1 from public.work_schedule_segments segment
       join public.work_schedules schedule on schedule.id = segment.schedule_id
       where schedule.organization_id <> org_a
     ) then
    raise exception 'ISOLATION FAILED: admin A sees company B attendance settings or schedules';
  end if;
  if exists (select 1 from public.work_locations) then
    raise exception 'ISOLATION FAILED: admin A sees company B work locations';
  end if;
  if exists (select 1 from public.pay_components where organization_id <> org_a)
     or exists (select 1 from public.payroll_settings where organization_id <> org_a)
     or exists (select 1 from public.payroll_runs)
     or exists (select 1 from public.payslips)
     or exists (select 1 from public.employee_contracts)
     or exists (select 1 from public.payroll_audit_log where organization_id <> org_a) then
    raise exception 'ISOLATION FAILED: admin A sees company B payroll data';
  end if;
  if (select count(*) from public.payroll_company) <> 1
     or exists (select 1 from public.payroll_company where organization_id <> org_a) then
    raise exception 'ISOLATION FAILED: admin A sees company B employer details';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'leave-attachments') then
    raise exception 'ISOLATION FAILED: admin A sees company B leave attachments';
  end if;

  -- Functions
  report := public.attendance_report(date '2026-09-01', date '2026-10-31');
  if (report ->> 'total')::integer <> 0 then
    raise exception 'ISOLATION FAILED: the attendance report shows company B punches';
  end if;

  begin
    perform public.attendance_day_summary(
      '00000000-0000-4000-8000-00000000b002', date '2026-10-01', clock_timestamp());
    raise exception 'ISOLATION FAILED: admin A read a company B attendance day';
  exception when raise_exception then
    if sqlerrm <> 'FORBIDDEN' then raise; end if;
  end;

  select id into b_correction from public.attendance_correction_requests;  -- invisible: null
  reset role;
  select id into b_correction from public.attendance_correction_requests
  where employee_id = '00000000-0000-4000-8000-00000000b002';
  select id into b_schedule from public.work_schedules where organization_id = org_b and is_default;
  set local role authenticated;

  begin
    perform public.apply_attendance_correction(b_correction, 'approved', null);
    raise exception 'ISOLATION FAILED: admin A decided a company B correction';
  exception when raise_exception then
    if sqlerrm <> 'CORRECTION_NOT_FOUND' then raise; end if;
  end;

  begin
    perform public.save_work_schedule(
      jsonb_build_object('id', b_schedule, 'name', 'Taken over', 'isDefault', true),
      '[]'::jsonb);
    raise exception 'ISOLATION FAILED: admin A changed a company B schedule';
  exception when raise_exception then
    if sqlerrm <> 'SCHEDULE_NOT_FOUND' then raise; end if;
  end;

  begin
    perform public.save_work_schedule(
      jsonb_build_object('name', 'A shifts'),
      '[{"isoWeekday":1,"kind":"work","startTime":"09:00","endTime":"17:00"}]'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'employeeId', '00000000-0000-4000-8000-00000000b002', 'effectiveFrom', '2026-10-01')));
    raise exception 'ISOLATION FAILED: admin A put a company B employee on a schedule';
  exception when raise_exception then
    if sqlerrm <> 'INVALID_ASSIGNMENTS' then raise; end if;
  end;

  -- A new default for A leaves B's default alone (checked below).
  perform public.save_work_schedule(
    jsonb_build_object('name', 'A new default', 'isDefault', true),
    '[{"isoWeekday":1,"kind":"work","startTime":"09:00","endTime":"17:00"}]'::jsonb);

  if exists (
    select 1 from public.attendance_credit_windows(null, date '2026-10-01', date '2026-10-01')
    where employee_id not in ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a002')
  ) then
    raise exception 'ISOLATION FAILED: leave accrual windows include company B employees';
  end if;
  begin
    perform public.attendance_credit_windows(
      '00000000-0000-4000-8000-00000000b002', date '2026-10-01', date '2026-10-01');
    raise exception 'ISOLATION FAILED: admin A read company B leave accrual windows';
  exception when raise_exception then
    if sqlerrm <> 'FORBIDDEN' then raise; end if;
  end;

  if exists (
    select 1 from public.payroll_attendance_month(date '2026-10-01', date '2026-10-31')
    where employee_id not in ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a002')
  ) then
    raise exception 'ISOLATION FAILED: payroll attendance includes company B employees';
  end if;

  -- Writes into company B are refused.
  begin
    insert into public.payroll_runs (organization_id, period) values (org_b, date '2026-08-01');
    raise exception 'ISOLATION FAILED: admin A created a payroll run in company B';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into public.pay_components (organization_id, code, name, kind)
    values (org_b, 'planted', 'Planted', 'earning');
    raise exception 'ISOLATION FAILED: admin A created a pay component in company B';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into public.work_locations (organization_id, name, latitude, longitude)
    values (org_b, 'Planted', 36.8, 10.18);
    raise exception 'ISOLATION FAILED: admin A created a work location in company B';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into storage.objects (bucket_id, name)
    values ('leave-attachments', '00000000-0000-4000-8000-00000000b002/planted.pdf');
    raise exception 'ISOLATION FAILED: admin A stored a file in a company B employee''s folder';
  exception when insufficient_privilege then
    null;
  end;

  -- Own company: a new run, rates for a new year and employer details.
  insert into public.payroll_runs (period) values (date '2026-09-01');
  if (select organization_id from public.payroll_runs where period = date '2026-09-01') is distinct from org_a then
    raise exception 'ISOLATION FAILED: a new payroll run did not get company A';
  end if;
  insert into public.payroll_company (name) values ('A Employer SARL')
  on conflict (organization_id) do update set name = excluded.name;
  if (select name from public.payroll_company) <> 'A Employer SARL' then
    raise exception 'ISOLATION FAILED: admin A could not save their employer details';
  end if;
end;
$$;

-- --- As an ordinary employee of company A ----------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);

do $$
begin
  if (select count(*) from public.authorizations) <> 1 then
    raise exception 'ISOLATION FAILED: an employee sees authorizations that are not theirs';
  end if;
  begin
    perform public.attendance_day_summary(
      '00000000-0000-4000-8000-00000000a001', date '2026-10-01', clock_timestamp());
    raise exception 'ISOLATION FAILED: an employee read a colleague''s attendance day';
  exception when raise_exception then
    if sqlerrm <> 'FORBIDDEN' then raise; end if;
  end;
  if (select name from public.payroll_company) <> 'A Employer SARL' then
    raise exception 'ISOLATION FAILED: an employee cannot read their employer details';
  end if;
  insert into storage.objects (bucket_id, name)
  values ('leave-attachments', '00000000-0000-4000-8000-00000000a002/note.pdf');
end;
$$;

reset role;

do $$
declare
  org_b uuid := current_setting('isolation.org_b')::uuid;
begin
  if (select name from public.work_schedules where organization_id = org_b and is_default) <> 'Default work week' then
    raise exception 'ISOLATION FAILED: company A changed company B''s default schedule';
  end if;
  if (select name from public.payroll_company where organization_id = org_b) <> 'Test Company B' then
    raise exception 'ISOLATION FAILED: company A changed company B''s employer details';
  end if;
end;
$$;

select 'All step 2 isolation checks passed' as result;

rollback;
