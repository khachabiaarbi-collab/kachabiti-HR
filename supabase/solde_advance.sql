-- Run in the Supabase SQL editor so solde can go below 0
-- when leave is taken in advance.

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'leave_balances'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%days_remaining%'
  loop
    execute format(
      'alter table public.leave_balances drop constraint if exists %I',
      constraint_name
    );
  end loop;
end;
$$;

alter table public.leave_balances
  alter column days_remaining type numeric using days_remaining::numeric;
