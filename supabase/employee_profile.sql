-- Run in the SQL editor if an employee cannot save their phone on My profile.
-- Lets a signed-in person update their own employees row. The app only writes phone.

drop policy if exists "employees_update_own" on public.employees;

create policy "employees_update_own"
on public.employees
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());
