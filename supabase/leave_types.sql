-- Run in the SQL editor. Seeds the Kachabiti leave catalog
-- (vacation, sick, parental, exceptional) and balances for current employees.

alter table public.leave_types
  add column if not exists code text;

create unique index if not exists leave_types_code_key
  on public.leave_types (code)
  where code is not null;

update public.leave_types
set code = 'VACATION', name = 'إجازة سنوية', default_days = coalesce(nullif(default_days, 0), 21)
where id = (
  select id from public.leave_types
  where code = 'VACATION' or name ~* 'annual|vacation' or name like '%سنوي%'
  order by id
  limit 1
);

update public.leave_types
set code = 'SICK', name = 'إجازة مرضية', default_days = coalesce(nullif(default_days, 0), 10)
where id = (
  select id from public.leave_types
  where code = 'SICK' or name ~* 'sick' or name like '%مرض%'
  order by id
  limit 1
);

update public.leave_types
set code = 'PARENTAL', name = 'إجازة أبوة / أمومة', default_days = 0
where id = (
  select id from public.leave_types
  where code = 'PARENTAL'
    or name ~* 'parental|paternity|maternity'
    or name like '%أبوة%'
    or name like '%أمومة%'
  order by id
  limit 1
);

with catalog (name, code, default_days) as (
  values
    ('إجازة سنوية', 'VACATION', 21),
    ('إجازة مرضية', 'SICK', 10),
    ('إجازة أبوة / أمومة', 'PARENTAL', 0),
    ('إجازة وفاة الزوج/الزوجة', 'EXCEPTIONAL_DEATH_SPOUSE', 3),
    ('إجازة وفاة أحد الوالدين أو أحد الأبناء', 'EXCEPTIONAL_DEATH_PARENT_CHILD', 3),
    ('إجازة وفاة أخ/أخت أو حفيد/حفيدة أو جد/جدة', 'EXCEPTIONAL_DEATH_OTHER', 2),
    ('إجازة زواج الموظّف', 'EXCEPTIONAL_MARRIAGE_EMPLOYEE', 3),
    ('إجازة زواج ابن/ابنة الموظّف', 'EXCEPTIONAL_MARRIAGE_CHILD', 1),
    ('إجازة ختان ابن الموظّف', 'EXCEPTIONAL_CIRCUMCISION', 1)
)
update public.leave_types as leave_type
set
  name = catalog.name,
  default_days = catalog.default_days
from catalog
where leave_type.code = catalog.code;

insert into public.leave_types (name, code, default_days)
select catalog.name, catalog.code, catalog.default_days
from (
  values
    ('إجازة سنوية', 'VACATION', 21),
    ('إجازة مرضية', 'SICK', 10),
    ('إجازة أبوة / أمومة', 'PARENTAL', 0),
    ('إجازة وفاة الزوج/الزوجة', 'EXCEPTIONAL_DEATH_SPOUSE', 3),
    ('إجازة وفاة أحد الوالدين أو أحد الأبناء', 'EXCEPTIONAL_DEATH_PARENT_CHILD', 3),
    ('إجازة وفاة أخ/أخت أو حفيد/حفيدة أو جد/جدة', 'EXCEPTIONAL_DEATH_OTHER', 2),
    ('إجازة زواج الموظّف', 'EXCEPTIONAL_MARRIAGE_EMPLOYEE', 3),
    ('إجازة زواج ابن/ابنة الموظّف', 'EXCEPTIONAL_MARRIAGE_CHILD', 1),
    ('إجازة ختان ابن الموظّف', 'EXCEPTIONAL_CIRCUMCISION', 1)
) as catalog(name, code, default_days)
where not exists (
  select 1 from public.leave_types as leave_type where leave_type.code = catalog.code
);

insert into public.leave_balances (employee_id, leave_type_id, days_remaining)
select
  employee.id,
  leave_type.id,
  case
    when leave_type.code = 'PARENTAL' then 0
    else leave_type.default_days
  end
from public.employees as employee
cross join public.leave_types as leave_type
on conflict (employee_id, leave_type_id) do nothing;
