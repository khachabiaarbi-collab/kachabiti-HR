# RHFlow multi-company (SaaS)

Branch `feature/generic-saas` turns the single-company Kachabiti app into
RHFlow: one app and one Supabase database shared by many customer
companies, each seeing only its own data. Work happens step by step, each
step tested on a development project (`rhflow-dev`) before it reaches
production.

| Step | Scope | State |
|---|---|---|
| 1 | Companies, company on core tables, RLS, new-user trigger | **done** |
| 2 | Company on attendance, authorizations, payroll, notifications, storage | **done** |
| 3 | Per-company settings: name, logo, colors, CNSS / tax id, timezone, leave and payroll rules | next |
| 4 | Roles and permissions per company (owner, admin, HR, manager, employee) | |
| 5 | Sign-up "Create my company", setup wizard, employee import | |
| 6 | KAN super-admin console (customers, suspend, usage) | |
| 7 | Plans, trial and billing | |
| 8 | Company sub-domains | |

## Step 1: what exists

[`supabase/saas/01_foundation.sql`](supabase/saas/01_foundation.sql):

- `organizations` (name, unique slug, `active` / `suspended`).
- `organization_id` (not null) on `employees`, `departments`, `leave_types`,
  `leave_balances`, `leave_requests`, `events`.
  - Rows created from the app get the signed-in user's company
    (column default `current_org_id()`).
  - Balances and requests always take their employee's company and must use
    a leave type of that company (trigger `leave_row_company`).
  - A row never changes company; departments, managers and employees must
    stay in the same company (`employees_guard`, `company_row_guard`).
  - Employees who are not staff can only edit their own contact details;
    role, status, email, department, start date, job title and leave rate
    are kept.
- Helpers for RLS: `current_org_id()`, `is_org_staff()`, `is_org_admin()`.
- RLS on the six core tables, always limited to the user's company (earlier
  policies on those tables are dropped and replaced):
  - everyone reads their colleagues, departments, leave types, events and
    leave requests (team calendar);
  - balances: own, or staff;
  - leave requests: create / change / delete your own while pending; staff
    do the rest;
  - departments, events: staff write; leave types: admins write.
- New Auth users (`handle_new_user`):
  - invited by an admin (`invited_at` set by the service role) → joins the
    company in the invite's `organization_id`;
  - sign-up with `company_name` in the metadata → creates that company with
    its leave catalog and becomes its admin;
  - anything else → no employee row, the app signs the user out. A sign-up
    can never join an existing company by itself.
- `create_organization(name, admin_email)`: sets up a company by hand from
  the SQL editor for an existing Auth user.
- Leave type codes are unique per company.

App side: server actions that use the service role (which ignores RLS)
first check with the user's own client that the target belongs to their
company (`sameCompanyEmployee` in [`lib/org-access.ts`](lib/org-access.ts)):
invites, account email / password, leave balances, photos, deletions and
leave attachments. Invites put the new employee in the inviter's company.

## Step 2: what exists

The feature scripts in `supabase/` are company-aware and stop with an error
until `01_foundation.sql` has run. Re-running any of them is still safe.

- **Company rows.** `organization_id` (filled with the user's company) on
  `attendance_settings` (one row per company instead of one for the whole
  database), `work_schedules` (one default per company), `work_locations`,
  `pay_components` (codes unique per company), `payroll_settings` (one row per
  company and year), `payroll_runs` (one per company and month),
  `payroll_company` (employer details, one row per company) and
  `payroll_audit_log`.
- **Employee rows.** Punches, corrections, schedule assignments, the
  attendance audit, authorizations, leave rate changes, contracts, employee
  pay components, payslips and payslip lines follow their employee's company
  (`is_my_org_employee()` in `01_foundation.sql`); no extra column.
- **Functions** that bypass RLS (`attendance_report`, `attendance_day_summary`,
  `apply_attendance_correction`, `save_work_schedule`,
  `attendance_credit_windows`, `payroll_attendance_month`, …) only reach the
  caller's company. Settings and the default schedule are looked up by the
  employee's company.
- **New companies** get attendance settings, a default work week
  (Mon–Fri 08:00–17:00 with a 12:00 break, Saturday 08:00–13:30), the usual
  pay components, employer details with the company name and **unverified**
  2026 rates: each company's accountant verifies its own rates.
- **Notifications** only reach staff of the requester's company.
- **Leave attachments** (storage): a person reads and uploads only in their
  own folder; staff read their company's.
- **Migration.** Rows created before companies go to the oldest company.
  Payroll rows get their company without firing triggers, so verified rates
  stay verified and paid months stay locked. An untouched `Kachabiti`
  employer row takes the company name.
- App: employer details are saved per company (`saveCompany` in
  `lib/payroll-run.ts`); a blank employer name is refused.
- `employee_solde.sql` (one-off balance fix) now refuses to run on a company
  database: it would rewrite every company's balances.
- The Saturday migration of the old default schedule was removed from
  `attendance.sql`; on a re-run it would have overwritten every company's
  Saturday hours. New companies get Saturday in their default week.

Still open (later steps):

- Avatars are in a public bucket: a photo URL works for anyone who has it
  (the path is the employee id).
- The UI still says "Kachabiti" (titles, logo, payslip fallback): step 3.
- Yearly payroll rates are copied per company; a shared, centrally verified
  set could replace them later.

## Setting up `rhflow-dev`

1. Supabase → SQL editor, in this order:
   1. `supabase/saas/01_foundation.sql`
   2. `supabase/authorizations.sql`
   3. `supabase/notifications.sql`
   4. `supabase/attendance.sql`
   5. `supabase/leave_accrual.sql`
   6. `supabase/payroll.sql`
   7. `supabase/work_locations.sql`
   8. `supabase/solde_advance.sql`, `supabase/authorization_solde.sql`
   9. `supabase/employee_avatars.sql`, `supabase/leave_attachments.sql`

   Do **not** run `handle_new_user.sql` or `leave_types.sql`: they are for
   single-company databases and now stop with an error on a company
   database.
   On a project set up before step 2, run the same list again in the same
   order: the scripts migrate what is there.
2. Run `supabase/saas/tests/01_isolation.sql`, then
   `supabase/saas/tests/02_isolation.sql`. They must end with
   `All isolation checks passed` and `All step 2 isolation checks passed`.
   Each runs in a transaction that is rolled back, so it leaves nothing
   behind.
3. Authentication → Users → Add user (email + password, auto-confirm), then
   in the SQL editor:
   ```sql
   select public.create_organization('Demo SARL', 'you@example.com');
   ```
4. Authentication → URL configuration: Site URL `http://localhost:3000`,
   redirect URLs `http://localhost:3000/auth/callback` and
   `http://localhost:3000/reset-password`.
5. Point `.env.local` at `rhflow-dev` (Project URL, publishable key, secret
   key), restart `npm run dev`, sign in with the user from 3.

## Migrating the Kachabiti production database (later)

`01_foundation.sql` also migrates an existing single-company database: all
current rows go to one company named `Kachabiti` (constant
`existing_company` in the script). With a backup, run the whole list from
"Setting up `rhflow-dev`" step 1 in order (the feature scripts move
attendance and payroll data to that company), then both isolation tests.
Deploy the app from this branch at the same time: it saves employer details
per company.
