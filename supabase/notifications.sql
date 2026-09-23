-- Run in the SQL editor. In-app bell notices for leave requests,
-- authorizations, and attendance corrections (submit / approve / reject),
-- one row per recipient.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.employees (id) on delete cascade,
  type text not null default 'pending'
    check (type in ('pending', 'approved', 'rejected', 'reminder')),
  message text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.notifications
  add column if not exists user_id uuid references public.employees (id) on delete cascade;

alter table public.notifications
  add column if not exists type text;

alter table public.notifications
  add column if not exists message text;

alter table public.notifications
  add column if not exists read boolean default false;

alter table public.notifications
  add column if not exists created_at timestamptz default now();

alter table public.notifications
  add column if not exists leave_request_id uuid references public.leave_requests (id) on delete cascade;

alter table public.notifications
  add column if not exists authorization_id uuid;

alter table public.notifications
  add column if not exists attendance_correction_id uuid;

do $$
begin
  if to_regclass('public.authorizations') is not null then
    begin
      alter table public.notifications
        add constraint notifications_authorization_id_fkey
        foreign key (authorization_id) references public.authorizations (id) on delete cascade;
    exception
      when duplicate_object then null;
    end;
  end if;

  if to_regclass('public.attendance_correction_requests') is not null then
    begin
      alter table public.notifications
        add constraint notifications_attendance_correction_id_fkey
        foreign key (attendance_correction_id)
        references public.attendance_correction_requests (id)
        on delete cascade;
    exception
      when duplicate_object then null;
    end;
  end if;
end;
$$;

create index if not exists notifications_user_id_idx
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

grant select, update on table public.notifications to authenticated;

drop policy if exists "notifications_select_own" on public.notifications;
drop policy if exists "notifications_update_own" on public.notifications;

create policy "notifications_select_own"
on public.notifications
for select
to authenticated
using (user_id = auth.uid());

create policy "notifications_update_own"
on public.notifications
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create or replace function public.employee_display_name(target_id uuid)
returns text
language sql
stable
as $$
  select coalesce(nullif(trim(full_name), ''), 'Someone')
  from public.employees
  where id = target_id;
$$;

create or replace function public.leave_type_display_name(target_id uuid)
returns text
language sql
stable
as $$
  select coalesce(nullif(trim(name), ''), 'leave')
  from public.leave_types
  where id = target_id;
$$;

create or replace function public.notify_leave_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor text;
  kind_label text;
  staff_message text;
begin
  actor := public.employee_display_name(new.employee_id);
  kind_label := public.leave_type_display_name(new.leave_type_id);

  if tg_op = 'INSERT' and coalesce(new.status, 'pending') = 'pending' then
    staff_message := actor || ' submitted a leave request (' || kind_label ||
      ', ' || to_char(new.start_date, 'Mon FMDD') || ' – ' ||
      to_char(new.end_date, 'Mon FMDD, YYYY') || ').';

    insert into public.notifications (user_id, type, message, leave_request_id)
    select employee.id, 'pending', staff_message, new.id
    from public.employees as employee
    where employee.role in ('admin', 'manager')
      and employee.id is distinct from new.employee_id
      and coalesce(employee.status, 'active') <> 'inactive';

    insert into public.notifications (user_id, type, message, leave_request_id)
    values (
      new.employee_id,
      'pending',
      'Your leave request (' || kind_label || ') was submitted for approval.',
      new.id
    );
  elsif tg_op = 'UPDATE'
    and new.status is distinct from old.status
    and new.status in ('approved', 'rejected')
  then
    insert into public.notifications (user_id, type, message, leave_request_id)
    values (
      new.employee_id,
      new.status,
      'Your leave request (' || kind_label || ') was ' || new.status || '.',
      new.id
    );
  end if;

  return new;
end;
$$;

create or replace function public.notify_authorization()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor text;
  staff_message text;
begin
  actor := public.employee_display_name(new.employee_id);

  if tg_op = 'INSERT' and coalesce(new.status, 'pending') = 'pending' then
    staff_message := actor || ' submitted an authorization for ' ||
      to_char(new.date, 'Mon FMDD, YYYY') || '.';

    insert into public.notifications (user_id, type, message, authorization_id)
    select employee.id, 'pending', staff_message, new.id
    from public.employees as employee
    where employee.role in ('admin', 'manager')
      and employee.id is distinct from new.employee_id
      and coalesce(employee.status, 'active') <> 'inactive';

    insert into public.notifications (user_id, type, message, authorization_id)
    values (
      new.employee_id,
      'pending',
      'Your authorization for ' || to_char(new.date, 'Mon FMDD, YYYY') ||
        ' was submitted for approval.',
      new.id
    );
  elsif tg_op = 'UPDATE'
    and new.status is distinct from old.status
    and new.status in ('approved', 'rejected')
  then
    insert into public.notifications (user_id, type, message, authorization_id)
    values (
      new.employee_id,
      new.status,
      'Your authorization for ' || to_char(new.date, 'Mon FMDD, YYYY') ||
        ' was ' || new.status || '.',
      new.id
    );
  end if;

  return new;
end;
$$;

drop trigger if exists leave_requests_notify on public.leave_requests;
create trigger leave_requests_notify
after insert or update of status on public.leave_requests
for each row
execute function public.notify_leave_request();

do $$
begin
  if to_regclass('public.authorizations') is not null then
    drop trigger if exists authorizations_notify on public.authorizations;
    create trigger authorizations_notify
    after insert or update of status on public.authorizations
    for each row
    execute function public.notify_authorization();
  end if;

  if to_regclass('public.attendance_correction_requests') is not null
    and to_regproc('public.notify_attendance_correction()') is not null
  then
    drop trigger if exists attendance_corrections_notify
      on public.attendance_correction_requests;
    create trigger attendance_corrections_notify
    after insert or update of status on public.attendance_correction_requests
    for each row
    execute function public.notify_attendance_correction();
  end if;
end;
$$;

-- Realtime: Database → Replication → supabase_realtime must include this table.
do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;
