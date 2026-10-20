-- Run once in the Supabase SQL editor so leave request files can be stored.
-- Files live under <employee id>/…; a person reads their own, staff read their
-- company's. Needs supabase/saas/01_foundation.sql.

do $$
begin
  if to_regprocedure('public.is_my_org_employee(uuid)') is null then
    raise exception 'Run supabase/saas/01_foundation.sql first.';
  end if;
end;
$$;

alter table public.leave_requests
  add column if not exists attachment_path text,
  add column if not exists attachment_name text;

insert into storage.buckets (id, name, public, file_size_limit)
values ('leave-attachments', 'leave-attachments', false, 10485760)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "leave_attachments_insert_own" on storage.objects;
drop policy if exists "leave_attachments_select_own_or_staff" on storage.objects;
drop policy if exists "leave_attachments_insert_authenticated" on storage.objects;
drop policy if exists "leave_attachments_select_authenticated" on storage.objects;

create policy "leave_attachments_insert_authenticated"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'leave-attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "leave_attachments_select_authenticated"
on storage.objects for select to authenticated
using (
  bucket_id = 'leave-attachments'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or (
      public.is_org_staff()
      and exists (
        select 1 from public.employees as owner
        where owner.id::text = (storage.foldername(name))[1]
          and owner.organization_id = public.current_org_id()
      )
    )
  )
);
