-- Run after authorizations.sql. Attendance uses server time and controlled RPCs;
-- employees never write the punch ledger directly.

create extension if not exists btree_gist with schema extensions;

create table if not exists public.attendance_settings (
  id boolean primary key default true check (id),
  timezone text not null default 'Africa/Tunis',
  grace_minutes integer not null default 5 check (grace_minutes between 0 and 120),
  max_sessions integer not null default 5 check (max_sessions between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'attendance_settings_timezone_check'
      and conrelid = 'public.attendance_settings'::regclass
  ) then
    alter table public.attendance_settings
      add constraint attendance_settings_timezone_check
      check (timezone = 'Africa/Tunis');
  end if;
end;
$$;

insert into public.attendance_settings (id)
values (true)
on conflict (id) do nothing;

create table if not exists public.work_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 100),
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists work_schedules_one_default_idx
  on public.work_schedules (is_default)
  where is_default;

create table if not exists public.work_schedule_segments (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.work_schedules (id) on delete cascade,
  iso_weekday smallint not null check (iso_weekday between 1 and 7),
  kind text not null check (kind in ('work', 'break')),
  start_time time not null,
  end_time time not null,
  position smallint not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  constraint work_schedule_segments_same_day check (end_time > start_time)
);

create index if not exists work_schedule_segments_schedule_day_idx
  on public.work_schedule_segments (schedule_id, iso_weekday, start_time);

create table if not exists public.employee_schedule_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  schedule_id uuid not null references public.work_schedules (id) on delete restrict,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  constraint employee_schedule_assignment_dates
    check (effective_to is null or effective_to >= effective_from),
  constraint employee_schedule_assignments_no_overlap
    exclude using gist (
      employee_id with =,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
    )
);

create index if not exists employee_schedule_assignments_lookup_idx
  on public.employee_schedule_assignments (employee_id, effective_from desc);

create table if not exists public.attendance_punches (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  work_date date not null,
  type text not null check (type in ('entry', 'exit')),
  occurred_at timestamptz not null,
  sequence_no smallint not null check (sequence_no between 1 and 10),
  idempotency_key uuid,
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by uuid references public.employees (id) on delete set null,
  source text not null default 'employee'
    check (source in ('employee', 'correction', 'admin')),
  voided_at timestamptz,
  voided_by uuid references public.employees (id) on delete set null,
  void_reason text,
  constraint attendance_punches_void_metadata check (
    (voided_at is null and voided_by is null and void_reason is null)
    or
    (voided_at is not null and void_reason is not null and char_length(trim(void_reason)) > 0)
  )
);

create unique index if not exists attendance_punches_idempotency_idx
  on public.attendance_punches (employee_id, idempotency_key)
  where idempotency_key is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'attendance_punches_active_sequence_unique'
      and conrelid = 'public.attendance_punches'::regclass
  ) then
    alter table public.attendance_punches
      add constraint attendance_punches_active_sequence_unique
      exclude using gist (
        employee_id with =,
        work_date with =,
        sequence_no with =
      )
      where (voided_at is null)
      deferrable initially immediate;
  end if;
end;
$$;

create index if not exists attendance_punches_employee_day_time_idx
  on public.attendance_punches (employee_id, work_date, occurred_at)
  where voided_at is null;

create index if not exists attendance_punches_day_employee_idx
  on public.attendance_punches (work_date, employee_id)
  where voided_at is null;

create table if not exists public.attendance_correction_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.employees (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  work_date date not null,
  operation text not null check (operation in ('add', 'change', 'void')),
  target_punch_id uuid references public.attendance_punches (id) on delete set null,
  proposed_type text check (proposed_type in ('entry', 'exit')),
  proposed_occurred_at timestamptz,
  reason text not null check (char_length(trim(reason)) between 3 and 2000),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  reviewer_id uuid references public.employees (id) on delete set null,
  decision_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint attendance_correction_proposal check (
    (
      operation = 'add'
      and target_punch_id is null
      and proposed_type is not null
      and proposed_occurred_at is not null
    )
    or (
      operation = 'change'
      and target_punch_id is not null
      and proposed_type is not null
      and proposed_occurred_at is not null
    )
    or (
      operation = 'void'
      and target_punch_id is not null
      and proposed_type is null
      and proposed_occurred_at is null
    )
  ),
  constraint attendance_correction_decision_metadata check (
    (status = 'pending' and reviewer_id is null and decided_at is null)
    or (status in ('approved', 'rejected') and reviewer_id is not null and decided_at is not null)
  )
);

create index if not exists attendance_corrections_employee_created_idx
  on public.attendance_correction_requests (employee_id, created_at desc);

create index if not exists attendance_corrections_status_created_idx
  on public.attendance_correction_requests (status, created_at);

create table if not exists public.attendance_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.employees (id) on delete set null,
  actor_snapshot jsonb not null default '{}'::jsonb,
  action text not null check (
    action in ('correction_approved', 'correction_rejected', 'punch_voided')
  ),
  employee_id uuid references public.employees (id) on delete set null,
  work_date date not null,
  punch_id uuid references public.attendance_punches (id) on delete set null,
  correction_request_id uuid references public.attendance_correction_requests (id) on delete set null,
  old_data jsonb,
  new_data jsonb,
  reason text,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists attendance_audit_employee_day_idx
  on public.attendance_audit_log (employee_id, work_date, created_at desc);

create or replace function public.attendance_is_staff(target_id uuid default auth.uid())
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
      and role in ('admin', 'manager')
      and coalesce(status, 'active') <> 'inactive'
  );
$$;

create or replace function public.attendance_validate_schedule_segment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.work_schedule_segments segment
    where segment.schedule_id = new.schedule_id
      and segment.iso_weekday = new.iso_weekday
      and segment.id <> new.id
      and segment.start_time < new.end_time
      and new.start_time < segment.end_time
  ) then
    raise exception using message = 'SCHEDULE_SEGMENT_OVERLAP';
  end if;
  return new;
end;
$$;

drop trigger if exists work_schedule_segments_validate on public.work_schedule_segments;
create trigger work_schedule_segments_validate
before insert or update on public.work_schedule_segments
for each row execute function public.attendance_validate_schedule_segment();

create or replace function public.attendance_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists attendance_settings_touch on public.attendance_settings;
create trigger attendance_settings_touch
before update on public.attendance_settings
for each row execute function public.attendance_touch_updated_at();

drop trigger if exists work_schedules_touch on public.work_schedules;
create trigger work_schedules_touch
before update on public.work_schedules
for each row execute function public.attendance_touch_updated_at();

create or replace function public.attendance_validate_correction_request()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  timezone_value text;
begin
  if tg_op = 'INSERT' then
    select timezone into timezone_value
    from public.attendance_settings
    where id;
    timezone_value := coalesce(timezone_value, 'Africa/Tunis');

    if new.proposed_occurred_at is not null
      and (new.proposed_occurred_at at time zone timezone_value)::date <> new.work_date
    then
      raise exception using message = 'PROPOSED_TIME_OUTSIDE_WORK_DATE';
    end if;

    if new.target_punch_id is not null and not exists (
      select 1
      from public.attendance_punches punch
      where punch.id = new.target_punch_id
        and punch.employee_id = new.employee_id
        and punch.work_date = new.work_date
        and punch.voided_at is null
    ) then
      raise exception using message = 'TARGET_PUNCH_NOT_FOUND';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists attendance_corrections_validate
  on public.attendance_correction_requests;
create trigger attendance_corrections_validate
before insert or update on public.attendance_correction_requests
for each row execute function public.attendance_validate_correction_request();

do $$
declare
  default_schedule_id uuid;
begin
  select id into default_schedule_id
  from public.work_schedules
  where is_default
  order by created_at
  limit 1;

  if default_schedule_id is null then
    insert into public.work_schedules (name, is_default)
    values ('Default work week', true)
    returning id into default_schedule_id;
  end if;

  if not exists (
    select 1 from public.work_schedule_segments
    where schedule_id = default_schedule_id
  ) then
    insert into public.work_schedule_segments
      (schedule_id, iso_weekday, kind, start_time, end_time, position)
    select default_schedule_id, weekday, segment.kind, segment.start_time, segment.end_time, segment.position
    from generate_series(1, 5) as weekday
    cross join (
      values
        ('work', '08:00'::time, '12:00'::time, 1::smallint),
        ('break', '12:00'::time, '13:00'::time, 2::smallint),
        ('work', '13:00'::time, '17:00'::time, 3::smallint)
    ) as segment(kind, start_time, end_time, position);
  end if;
end;
$$;

create or replace function public.attendance_resolved_schedule(
  p_employee_id uuid,
  p_work_date date
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select assignment.schedule_id
      from public.employee_schedule_assignments assignment
      join public.work_schedules schedule on schedule.id = assignment.schedule_id
      where assignment.employee_id = p_employee_id
        and assignment.effective_from <= p_work_date
        and (assignment.effective_to is null or assignment.effective_to >= p_work_date)
        and schedule.is_active
      order by assignment.effective_from desc
      limit 1
    ),
    (
      select id
      from public.work_schedules
      where is_default and is_active
      order by created_at
      limit 1
    )
  );
$$;

create or replace function public.attendance_day_summary(
  p_employee_id uuid,
  p_work_date date,
  p_as_of timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  settings_row public.attendance_settings%rowtype;
  schedule_id_value uuid;
  punch public.attendance_punches%rowtype;
  open_entry public.attendance_punches%rowtype;
  latest_punch public.attendance_punches%rowtype;
  timeline jsonb := '[]'::jsonb;
  sessions jsonb := '[]'::jsonb;
  schedule_segments jsonb := '[]'::jsonb;
  authorizations jsonb := '[]'::jsonb;
  worked_seconds numeric := 0;
  completed_sessions integer := 0;
  entry_count integer := 0;
  first_entry timestamptz;
  last_exit timestamptz;
  open_since timestamptz;
  state_value text := 'absent';
  next_action text := 'entry';
  block_reason text;
  expected_type text := 'entry';
  invalid_sequence boolean := false;
  is_working_day boolean := false;
begin
  if auth.uid() is null
    or (auth.uid() <> p_employee_id and not public.attendance_is_staff())
  then
    raise exception using message = 'FORBIDDEN';
  end if;

  select * into settings_row from public.attendance_settings where id;
  if not found then
    settings_row.timezone := 'Africa/Tunis';
    settings_row.grace_minutes := 5;
    settings_row.max_sessions := 5;
  end if;

  schedule_id_value := public.attendance_resolved_schedule(p_employee_id, p_work_date);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', segment.id,
    'kind', segment.kind,
    'startTime', segment.start_time,
    'endTime', segment.end_time,
    'position', segment.position
  ) order by segment.position, segment.start_time), '[]'::jsonb)
  into schedule_segments
  from public.work_schedule_segments segment
  where segment.schedule_id = schedule_id_value
    and segment.iso_weekday = extract(isodow from p_work_date);

  is_working_day := exists (
    select 1
    from public.work_schedule_segments segment
    where segment.schedule_id = schedule_id_value
      and segment.iso_weekday = extract(isodow from p_work_date)
      and segment.kind = 'work'
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', auth_row.id,
    'startTime', auth_row.start_time,
    'endTime', auth_row.end_time,
    'durationMinutes', auth_row.duration_minutes,
    'reason', auth_row.reason
  ) order by auth_row.start_time), '[]'::jsonb)
  into authorizations
  from public.authorizations auth_row
  where auth_row.employee_id = p_employee_id
    and auth_row.date = p_work_date
    and auth_row.status = 'approved';

  for punch in
    select *
    from public.attendance_punches
    where employee_id = p_employee_id
      and work_date = p_work_date
      and voided_at is null
    order by occurred_at, recorded_at, id
  loop
    timeline := timeline || jsonb_build_array(jsonb_build_object(
      'id', punch.id,
      'type', punch.type,
      'occurredAt', punch.occurred_at,
      'sequenceNo', punch.sequence_no,
      'source', punch.source
    ));
    latest_punch := punch;

    if punch.type <> expected_type then
      invalid_sequence := true;
    end if;

    if punch.type = 'entry' then
      entry_count := entry_count + 1;
      first_entry := coalesce(first_entry, punch.occurred_at);
      open_entry := punch;
      expected_type := 'exit';
    else
      last_exit := punch.occurred_at;
      if open_entry.id is not null and punch.occurred_at > open_entry.occurred_at then
        worked_seconds := worked_seconds + extract(epoch from (punch.occurred_at - open_entry.occurred_at));
        completed_sessions := completed_sessions + 1;
        sessions := sessions || jsonb_build_array(jsonb_build_object(
          'entryId', open_entry.id,
          'exitId', punch.id,
          'entryAt', open_entry.occurred_at,
          'exitAt', punch.occurred_at,
          'durationMinutes', floor(extract(epoch from (punch.occurred_at - open_entry.occurred_at)) / 60)
        ));
      else
        invalid_sequence := true;
      end if;
      open_entry := null;
      expected_type := 'entry';
    end if;
  end loop;

  if open_entry.id is not null then
    open_since := open_entry.occurred_at;
    sessions := sessions || jsonb_build_array(jsonb_build_object(
      'entryId', open_entry.id,
      'exitId', null,
      'entryAt', open_entry.occurred_at,
      'exitAt', null,
      'durationMinutes', null
    ));
  end if;

  if latest_punch.id is not null and latest_punch.type = 'entry' then
    state_value := case when p_work_date < (p_as_of at time zone settings_row.timezone)::date
      then 'incomplete' else 'present' end;
    next_action := case when state_value = 'present' then 'exit' else null end;
  elsif entry_count >= settings_row.max_sessions then
    state_value := 'locked';
    next_action := null;
    block_reason := 'MAX_SESSIONS';
  end if;

  if invalid_sequence then
    block_reason := 'INVALID_SEQUENCE';
    next_action := null;
  end if;

  return jsonb_build_object(
    'employeeId', p_employee_id,
    'workDate', p_work_date,
    'serverTime', p_as_of,
    'timezone', settings_row.timezone,
    'state', state_value,
    'nextAction', next_action,
    'blockReason', block_reason,
    'latestPunchId', latest_punch.id,
    'firstEntryAt', first_entry,
    'lastExitAt', last_exit,
    'openSince', open_since,
    'workedMinutes', floor(worked_seconds / 60),
    'openMinutes', case when open_since is null then 0
      else greatest(0, floor(extract(epoch from (p_as_of - open_since)) / 60)) end,
    'completedSessions', completed_sessions,
    'sessionsStarted', entry_count,
    'remainingSessions', greatest(0, settings_row.max_sessions - entry_count),
    'isWorkingDay', is_working_day,
    'isUnscheduledWork', not is_working_day and latest_punch.id is not null,
    'hasInvalidSequence', invalid_sequence,
    'timeline', timeline,
    'sessions', sessions,
    'scheduleId', schedule_id_value,
    'scheduleSegments', schedule_segments,
    'authorizations', authorizations
  );
end;
$$;

create or replace function public.punch_attendance(
  p_idempotency_key uuid,
  p_expected_latest_punch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  now_value timestamptz := clock_timestamp();
  timezone_value text;
  work_date_value date;
  latest_punch public.attendance_punches%rowtype;
  existing_punch public.attendance_punches%rowtype;
  next_type text;
  next_sequence integer;
  entry_count integer;
  max_sessions_value integer;
  inserted_id uuid;
  result jsonb;
begin
  if actor_id is null then
    raise exception using message = 'UNAUTHENTICATED';
  end if;
  if p_idempotency_key is null then
    raise exception using message = 'INVALID_IDEMPOTENCY_KEY';
  end if;
  if not exists (
    select 1 from public.employees
    where id = actor_id and coalesce(status, 'active') <> 'inactive'
  ) then
    raise exception using message = 'FORBIDDEN';
  end if;

  select timezone, max_sessions into timezone_value, max_sessions_value
  from public.attendance_settings where id;
  timezone_value := coalesce(timezone_value, 'Africa/Tunis');
  max_sessions_value := coalesce(max_sessions_value, 5);
  work_date_value := (now_value at time zone timezone_value)::date;

  perform pg_advisory_xact_lock(hashtextextended(actor_id::text || ':' || work_date_value::text, 0));

  select * into existing_punch
  from public.attendance_punches
  where employee_id = actor_id and idempotency_key = p_idempotency_key;
  if found then
    result := public.attendance_day_summary(actor_id, work_date_value, now_value);
    return result || jsonb_build_object('punchId', existing_punch.id, 'replayed', true);
  end if;

  select * into latest_punch
  from public.attendance_punches
  where employee_id = actor_id
    and work_date = work_date_value
    and voided_at is null
  order by occurred_at desc, recorded_at desc, id desc
  limit 1;

  if latest_punch.id is distinct from p_expected_latest_punch_id then
    raise exception using message = 'STALE_STATE';
  end if;

  select count(*) filter (where type = 'entry'), count(*) + 1
  into entry_count, next_sequence
  from public.attendance_punches
  where employee_id = actor_id
    and work_date = work_date_value
    and voided_at is null;

  next_type := case when latest_punch.type = 'entry' then 'exit' else 'entry' end;
  if next_type = 'entry' and entry_count >= max_sessions_value then
    raise exception using message = 'MAX_SESSIONS';
  end if;
  if next_sequence > max_sessions_value * 2 then
    raise exception using message = 'MAX_SESSIONS';
  end if;

  insert into public.attendance_punches (
    employee_id, work_date, type, occurred_at, sequence_no,
    idempotency_key, recorded_by, source
  )
  values (
    actor_id, work_date_value, next_type, now_value, next_sequence,
    p_idempotency_key, actor_id, 'employee'
  )
  returning id into inserted_id;

  result := public.attendance_day_summary(actor_id, work_date_value, now_value);
  return result || jsonb_build_object('punchId', inserted_id, 'replayed', false);
end;
$$;

create or replace function public.attendance_today()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  now_value timestamptz := clock_timestamp();
  timezone_value text;
  today_value date;
  incomplete_date date;
  result jsonb;
begin
  if actor_id is null or not exists (
    select 1 from public.employees
    where id = actor_id and coalesce(status, 'active') <> 'inactive'
  ) then
    raise exception using message = 'FORBIDDEN';
  end if;

  select timezone into timezone_value from public.attendance_settings where id;
  timezone_value := coalesce(timezone_value, 'Africa/Tunis');
  today_value := (now_value at time zone timezone_value)::date;

  select day.work_date into incomplete_date
  from (
    select distinct on (punch.work_date)
      punch.work_date, punch.type
    from public.attendance_punches punch
    where punch.employee_id = actor_id
      and punch.work_date < today_value
      and punch.voided_at is null
    order by punch.work_date desc, punch.occurred_at desc, punch.recorded_at desc, punch.id desc
  ) day
  where day.type = 'entry'
  order by day.work_date desc
  limit 1;

  result := public.attendance_day_summary(actor_id, today_value, now_value);
  return result || jsonb_build_object(
    'previousIncomplete',
    case when incomplete_date is null then null
      else public.attendance_day_summary(actor_id, incomplete_date, now_value) end
  );
end;
$$;

create or replace function public.apply_attendance_correction(
  p_request_id uuid,
  p_decision text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  request_row public.attendance_correction_requests%rowtype;
  target_row public.attendance_punches%rowtype;
  changed_id uuid;
  old_snapshot jsonb;
  new_snapshot jsonb;
  invalid_count integer;
  active_count integer;
begin
  if actor_id is null or not public.attendance_is_staff(actor_id) then
    raise exception using message = 'FORBIDDEN';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception using message = 'INVALID_DECISION';
  end if;

  select * into request_row
  from public.attendance_correction_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception using message = 'CORRECTION_NOT_FOUND';
  end if;
  if request_row.status <> 'pending' then
    raise exception using message = 'CORRECTION_ALREADY_DECIDED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    request_row.employee_id::text || ':' || request_row.work_date::text, 0
  ));

  if p_decision = 'rejected' then
    update public.attendance_correction_requests
    set status = 'rejected', reviewer_id = actor_id,
        decision_note = nullif(trim(p_note), ''), decided_at = clock_timestamp()
    where id = request_row.id;

    insert into public.attendance_audit_log (
      actor_id, actor_snapshot, action, employee_id, work_date,
      correction_request_id, reason
    )
    select actor_id,
      jsonb_build_object('id', employee.id, 'name', employee.full_name, 'role', employee.role),
      'correction_rejected', request_row.employee_id, request_row.work_date,
      request_row.id, coalesce(nullif(trim(p_note), ''), request_row.reason)
    from public.employees employee where employee.id = actor_id;

    return jsonb_build_object('requestId', request_row.id, 'status', 'rejected');
  end if;

  set constraints public.attendance_punches_active_sequence_unique deferred;

  if request_row.operation in ('change', 'void') then
    select * into target_row
    from public.attendance_punches
    where id = request_row.target_punch_id
      and employee_id = request_row.employee_id
      and work_date = request_row.work_date
      and voided_at is null
    for update;
    if not found then
      raise exception using message = 'TARGET_PUNCH_NOT_FOUND';
    end if;
    old_snapshot := to_jsonb(target_row);
  end if;

  if request_row.operation = 'add' then
    select count(*) into active_count
    from public.attendance_punches
    where employee_id = request_row.employee_id
      and work_date = request_row.work_date
      and voided_at is null;
    if active_count >= 10 then
      raise exception using message = 'INVALID_SEQUENCE';
    end if;

    insert into public.attendance_punches (
      employee_id, work_date, type, occurred_at, sequence_no,
      recorded_by, source
    )
    values (
      request_row.employee_id, request_row.work_date, request_row.proposed_type,
      request_row.proposed_occurred_at, 10, actor_id, 'correction'
    )
    returning id into changed_id;
  elsif request_row.operation = 'change' then
    update public.attendance_punches
    set type = request_row.proposed_type,
        occurred_at = request_row.proposed_occurred_at,
        recorded_by = actor_id,
        source = 'correction'
    where id = target_row.id
    returning id into changed_id;
  else
    update public.attendance_punches
    set voided_at = clock_timestamp(), voided_by = actor_id,
        void_reason = request_row.reason
    where id = target_row.id
    returning id into changed_id;
  end if;

  with ordered as (
    select id, row_number() over (order by occurred_at, recorded_at, id) as new_sequence
    from public.attendance_punches
    where employee_id = request_row.employee_id
      and work_date = request_row.work_date
      and voided_at is null
  )
  update public.attendance_punches punch
  set sequence_no = ordered.new_sequence
  from ordered
  where punch.id = ordered.id;

  with sequenced as (
    select sequence_no, type, occurred_at,
      lag(occurred_at) over (order by sequence_no) as previous_occurred_at
    from public.attendance_punches
    where employee_id = request_row.employee_id
      and work_date = request_row.work_date
      and voided_at is null
  )
  select count(*), count(*) filter (
    where (sequence_no % 2 = 1 and type <> 'entry')
       or (sequence_no % 2 = 0 and type <> 'exit')
       or (previous_occurred_at is not null and occurred_at <= previous_occurred_at)
  )
  into active_count, invalid_count
  from sequenced;

  if active_count > 10 or invalid_count > 0 then
    raise exception using message = 'INVALID_SEQUENCE';
  end if;

  select to_jsonb(punch) into new_snapshot
  from public.attendance_punches punch where punch.id = changed_id;

  update public.attendance_correction_requests
  set status = 'approved', reviewer_id = actor_id,
      decision_note = nullif(trim(p_note), ''), decided_at = clock_timestamp()
  where id = request_row.id;

  insert into public.attendance_audit_log (
    actor_id, actor_snapshot, action, employee_id, work_date, punch_id,
    correction_request_id, old_data, new_data, reason
  )
  select actor_id,
    jsonb_build_object('id', employee.id, 'name', employee.full_name, 'role', employee.role),
    'correction_approved', request_row.employee_id, request_row.work_date, changed_id,
    request_row.id, old_snapshot, new_snapshot,
    coalesce(nullif(trim(p_note), ''), request_row.reason)
  from public.employees employee where employee.id = actor_id;

  return public.attendance_day_summary(
    request_row.employee_id, request_row.work_date, clock_timestamp()
  ) || jsonb_build_object('requestId', request_row.id, 'status', 'approved');
end;
$$;

create or replace function public.attendance_report(
  p_from date,
  p_to date,
  p_employee_id uuid default null,
  p_department_id uuid default null,
  p_status text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  item record;
  summary jsonb;
  items jsonb := '[]'::jsonb;
  matching_total integer := 0;
begin
  if not public.attendance_is_staff() then
    raise exception using message = 'FORBIDDEN';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    raise exception using message = 'INVALID_DATE_RANGE';
  end if;
  if p_limit < 1 or p_limit > 100 or p_offset < 0 then
    raise exception using message = 'INVALID_PAGINATION';
  end if;

  for item in
    select punch.employee_id, punch.work_date, employee.full_name,
      employee.department_id, department.name as department_name
    from public.attendance_punches punch
    join public.employees employee on employee.id = punch.employee_id
    left join public.departments department on department.id = employee.department_id
    where punch.work_date between p_from and p_to
      and punch.voided_at is null
      and (p_employee_id is null or punch.employee_id = p_employee_id)
      and (p_department_id is null or employee.department_id = p_department_id)
    group by punch.employee_id, punch.work_date, employee.full_name,
      employee.department_id, department.name
    order by punch.work_date desc, employee.full_name
  loop
    summary := public.attendance_day_summary(
      item.employee_id, item.work_date, clock_timestamp()
    );
    if p_status is null or p_status = '' or summary->>'state' = p_status then
      if matching_total >= p_offset and matching_total < p_offset + p_limit then
        items := items || jsonb_build_array(
          summary || jsonb_build_object(
            'employeeName', item.full_name,
            'departmentId', item.department_id,
            'departmentName', coalesce(item.department_name, 'Unassigned')
          )
        );
      end if;
      matching_total := matching_total + 1;
    end if;
  end loop;

  return jsonb_build_object('items', items, 'total', matching_total);
end;
$$;

create or replace function public.save_work_schedule(
  p_schedule jsonb,
  p_segments jsonb,
  p_assignments jsonb default null,
  p_settings jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  schedule_id_value uuid;
  segment jsonb;
  assignment jsonb;
  make_default boolean;
begin
  if not public.attendance_is_staff() then
    raise exception using message = 'FORBIDDEN';
  end if;
  if p_schedule is null
    or char_length(trim(coalesce(p_schedule->>'name', ''))) not between 1 and 100
    or jsonb_typeof(coalesce(p_segments, 'null'::jsonb)) <> 'array'
  then
    raise exception using message = 'INVALID_SCHEDULE';
  end if;

  schedule_id_value := nullif(p_schedule->>'id', '')::uuid;
  make_default := coalesce((p_schedule->>'isDefault')::boolean, false);

  if make_default then
    update public.work_schedules set is_default = false where is_default;
  end if;

  if schedule_id_value is null then
    insert into public.work_schedules (name, is_default, is_active)
    values (
      trim(p_schedule->>'name'),
      make_default,
      coalesce((p_schedule->>'isActive')::boolean, true)
    )
    returning id into schedule_id_value;
  else
    update public.work_schedules
    set name = trim(p_schedule->>'name'),
        is_default = make_default,
        is_active = coalesce((p_schedule->>'isActive')::boolean, true)
    where id = schedule_id_value;
    if not found then
      raise exception using message = 'SCHEDULE_NOT_FOUND';
    end if;
    delete from public.work_schedule_segments where schedule_id = schedule_id_value;
  end if;

  for segment in select value from jsonb_array_elements(p_segments)
  loop
    insert into public.work_schedule_segments (
      schedule_id, iso_weekday, kind, start_time, end_time, position
    )
    values (
      schedule_id_value,
      (segment->>'isoWeekday')::smallint,
      segment->>'kind',
      (segment->>'startTime')::time,
      (segment->>'endTime')::time,
      coalesce((segment->>'position')::smallint, 0)
    );
  end loop;

  if p_assignments is not null then
    if jsonb_typeof(p_assignments) <> 'array' then
      raise exception using message = 'INVALID_ASSIGNMENTS';
    end if;
    delete from public.employee_schedule_assignments
    where schedule_id = schedule_id_value;
    for assignment in select value from jsonb_array_elements(p_assignments)
    loop
      insert into public.employee_schedule_assignments (
        employee_id, schedule_id, effective_from, effective_to
      )
      values (
        (assignment->>'employeeId')::uuid,
        schedule_id_value,
        (assignment->>'effectiveFrom')::date,
        nullif(assignment->>'effectiveTo', '')::date
      );
    end loop;
  end if;

  if p_settings is not null then
    update public.attendance_settings
    set timezone = coalesce(nullif(trim(p_settings->>'timezone'), ''), timezone),
        grace_minutes = coalesce((p_settings->>'graceMinutes')::integer, grace_minutes),
        max_sessions = coalesce((p_settings->>'maxSessions')::integer, max_sessions)
    where id;
  end if;

  if not exists (select 1 from public.work_schedules where is_default) then
    raise exception using message = 'DEFAULT_SCHEDULE_REQUIRED';
  end if;

  return jsonb_build_object('id', schedule_id_value);
end;
$$;

alter table public.attendance_settings enable row level security;
alter table public.work_schedules enable row level security;
alter table public.work_schedule_segments enable row level security;
alter table public.employee_schedule_assignments enable row level security;
alter table public.attendance_punches enable row level security;
alter table public.attendance_correction_requests enable row level security;
alter table public.attendance_audit_log enable row level security;

grant select on public.attendance_settings, public.work_schedules,
  public.work_schedule_segments, public.employee_schedule_assignments to authenticated;
revoke insert, update, delete on public.attendance_settings, public.work_schedules,
  public.work_schedule_segments, public.employee_schedule_assignments from authenticated;
grant select on public.attendance_punches, public.attendance_correction_requests to authenticated;
grant insert on public.attendance_correction_requests to authenticated;
grant select on public.attendance_audit_log to authenticated;
revoke insert, update, delete on public.attendance_punches from authenticated;
revoke update, delete on public.attendance_correction_requests from authenticated;
revoke insert, update, delete on public.attendance_audit_log from authenticated;

drop policy if exists "attendance_settings_read" on public.attendance_settings;
create policy "attendance_settings_read" on public.attendance_settings
for select to authenticated using (true);
drop policy if exists "attendance_settings_staff_write" on public.attendance_settings;
create policy "attendance_settings_staff_write" on public.attendance_settings
for all to authenticated using (public.attendance_is_staff())
with check (public.attendance_is_staff());

drop policy if exists "work_schedules_read" on public.work_schedules;
create policy "work_schedules_read" on public.work_schedules
for select to authenticated using (true);
drop policy if exists "work_schedules_staff_write" on public.work_schedules;
create policy "work_schedules_staff_write" on public.work_schedules
for all to authenticated using (public.attendance_is_staff())
with check (public.attendance_is_staff());

drop policy if exists "work_schedule_segments_read" on public.work_schedule_segments;
create policy "work_schedule_segments_read" on public.work_schedule_segments
for select to authenticated using (true);
drop policy if exists "work_schedule_segments_staff_write" on public.work_schedule_segments;
create policy "work_schedule_segments_staff_write" on public.work_schedule_segments
for all to authenticated using (public.attendance_is_staff())
with check (public.attendance_is_staff());

drop policy if exists "schedule_assignments_read" on public.employee_schedule_assignments;
create policy "schedule_assignments_read" on public.employee_schedule_assignments
for select to authenticated using (
  employee_id = auth.uid() or public.attendance_is_staff()
);
drop policy if exists "schedule_assignments_staff_write" on public.employee_schedule_assignments;
create policy "schedule_assignments_staff_write" on public.employee_schedule_assignments
for all to authenticated using (public.attendance_is_staff())
with check (public.attendance_is_staff());

drop policy if exists "attendance_punches_read" on public.attendance_punches;
create policy "attendance_punches_read" on public.attendance_punches
for select to authenticated using (
  employee_id = auth.uid() or public.attendance_is_staff()
);

drop policy if exists "attendance_corrections_read" on public.attendance_correction_requests;
create policy "attendance_corrections_read" on public.attendance_correction_requests
for select to authenticated using (
  employee_id = auth.uid() or requester_id = auth.uid() or public.attendance_is_staff()
);
drop policy if exists "attendance_corrections_submit" on public.attendance_correction_requests;
create policy "attendance_corrections_submit" on public.attendance_correction_requests
for insert to authenticated with check (
  requester_id = auth.uid()
  and status = 'pending'
  and reviewer_id is null
  and decided_at is null
  and (employee_id = auth.uid() or public.attendance_is_staff())
);

drop policy if exists "attendance_audit_staff_read" on public.attendance_audit_log;
create policy "attendance_audit_staff_read" on public.attendance_audit_log
for select to authenticated using (public.attendance_is_staff());

revoke all on function public.attendance_is_staff(uuid) from public;
revoke all on function public.attendance_resolved_schedule(uuid, date) from public;
revoke all on function public.attendance_day_summary(uuid, date, timestamptz) from public;
revoke all on function public.punch_attendance(uuid, uuid) from public;
revoke all on function public.attendance_today() from public;
revoke all on function public.apply_attendance_correction(uuid, text, text) from public;
revoke all on function public.attendance_report(date, date, uuid, uuid, text, integer, integer) from public;
revoke all on function public.save_work_schedule(jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function public.attendance_day_summary(uuid, date, timestamptz) to authenticated;
grant execute on function public.attendance_is_staff(uuid) to authenticated;
grant execute on function public.punch_attendance(uuid, uuid) to authenticated;
grant execute on function public.attendance_today() to authenticated;
grant execute on function public.apply_attendance_correction(uuid, text, text) to authenticated;
grant execute on function public.attendance_report(date, date, uuid, uuid, text, integer, integer) to authenticated;
grant execute on function public.save_work_schedule(jsonb, jsonb, jsonb, jsonb) to authenticated;

create or replace function public.notify_attendance_correction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor text;
  work_date_label text;
  staff_message text;
begin
  if to_regclass('public.notifications') is null then
    return new;
  end if;

  actor := coalesce(
    (
      select nullif(trim(employee.full_name), '')
      from public.employees employee
      where employee.id = new.requester_id
    ),
    'Someone'
  );
  work_date_label := to_char(new.work_date, 'Mon FMDD, YYYY');

  if tg_op = 'INSERT' and coalesce(new.status, 'pending') = 'pending' then
    staff_message := actor || ' submitted an attendance correction for ' ||
      work_date_label || '.';

    insert into public.notifications (
      user_id, type, message, attendance_correction_id
    )
    select employee.id, 'pending', staff_message, new.id
    from public.employees as employee
    where employee.role in ('admin', 'manager')
      and employee.id is distinct from new.requester_id
      and coalesce(employee.status, 'active') <> 'inactive';

    insert into public.notifications (
      user_id, type, message, attendance_correction_id
    )
    values (
      new.requester_id,
      'pending',
      'Your attendance correction for ' || work_date_label ||
        ' was submitted for approval.',
      new.id
    );
  elsif tg_op = 'UPDATE'
    and new.status is distinct from old.status
    and new.status in ('approved', 'rejected')
  then
    insert into public.notifications (
      user_id, type, message, attendance_correction_id
    )
    values (
      new.requester_id,
      new.status,
      'Your attendance correction for ' || work_date_label ||
        ' was ' || new.status || '.',
      new.id
    );
  end if;

  return new;
end;
$$;

do $$
begin
  if to_regclass('public.notifications') is null then
    return;
  end if;

  alter table public.notifications
    add column if not exists attendance_correction_id uuid;

  begin
    alter table public.notifications
      add constraint notifications_attendance_correction_id_fkey
      foreign key (attendance_correction_id)
      references public.attendance_correction_requests (id)
      on delete cascade;
  exception
    when duplicate_object then null;
  end;

  drop trigger if exists attendance_corrections_notify
    on public.attendance_correction_requests;
  create trigger attendance_corrections_notify
  after insert or update of status on public.attendance_correction_requests
  for each row
  execute function public.notify_attendance_correction();
end;
$$;
