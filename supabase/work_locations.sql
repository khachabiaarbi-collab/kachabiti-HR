-- Work sites used to restrict employee punches to the office (GPS).
-- Run after supabase/attendance.sql. Each company has its own sites.

do $$
begin
  if to_regprocedure('public.can_manage_employee(uuid)') is null then
    raise exception 'Run supabase/saas/01_foundation.sql first.';
  end if;
end;
$$;

create table if not exists public.work_locations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_meters integer not null default 150 check (radius_meters between 30 and 2000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sites from before companies go to the oldest company.
alter table public.work_locations
  add column if not exists organization_id uuid references public.organizations (id) on delete cascade;
update public.work_locations
set organization_id = (select id from public.organizations order by created_at limit 1)
where organization_id is null;
alter table public.work_locations alter column organization_id set default public.current_org_id();
alter table public.work_locations alter column organization_id set not null;
create index if not exists work_locations_organization_idx on public.work_locations (organization_id);

alter table public.attendance_punches
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists accuracy_meters double precision,
  add column if not exists work_location_id uuid references public.work_locations (id) on delete set null;

alter table public.attendance_punches
  drop constraint if exists attendance_punches_coordinates_check;
alter table public.attendance_punches
  add constraint attendance_punches_coordinates_check check (
    (latitude is null and longitude is null)
    or (
      latitude between -90 and 90
      and longitude between -180 and 180
    )
  );

alter table public.work_locations enable row level security;

drop policy if exists "work_locations_read" on public.work_locations;
create policy "work_locations_read" on public.work_locations
for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "work_locations_staff_write" on public.work_locations;
create policy "work_locations_staff_write" on public.work_locations
for all to authenticated
using (organization_id = public.current_org_id() and public.is_org_hr())
with check (organization_id = public.current_org_id() and public.is_org_hr());
