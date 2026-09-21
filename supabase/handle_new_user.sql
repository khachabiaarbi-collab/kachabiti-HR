-- Run this in the Supabase SQL editor after the tables/RLS script.
-- Creates an employees row for every new Auth user (bypasses admin-only INSERT RLS).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.employees (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email,
    'employee'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill users created before this trigger existed
insert into public.employees (id, full_name, email, role)
select
  id,
  coalesce(raw_user_meta_data->>'full_name', split_part(email, '@', 1)),
  email,
  'employee'
from auth.users
on conflict (id) do nothing;

-- First admin: create the user in Authentication → Users, then run:
-- update public.employees set role = 'admin' where email = 'you@kachabiti.com';
