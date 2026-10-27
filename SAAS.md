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
| 3 | Per-company settings: name, logo, colors, CNSS / tax id, timezone, leave and payroll rules | **done** (timezone deferred) |
| 4 | Roles and permissions per company (owner, admin, HR, manager, employee) | **done** |
| 5 | Sign-up "Create my company", setup wizard, employee import | next |
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

## Step 3: what exists

[`supabase/saas/03_company_settings.sql`](supabase/saas/03_company_settings.sql):

- `organizations` gets `logo_url`, `brand_color` (`#rrggbb`) and
  `monthly_leave_days` (vacation earned per month, 1.5 by default).
- Admins edit their company's name, logo, colour and leave rate; the
  `organizations_guard` trigger keeps its status, slug and id (suspending a
  company stays with the service role, step 6).
- New employees start with their company's rate (`employees_company_leave_rate`;
  the column default on `employees.monthly_leave_days` is removed).
- Public `company-logos` bucket; the app uploads with the service role
  under `<company id>/logo.<ext>`.
- Leave catalog per company: `leave_types.active`, and the
  `leave_types_policy_guard` trigger. Built-in types (codes `VACATION`,
  `ANNUAL`, `SICK`, `PARENTAL`, `UNPAID`) drive vacation earning and payroll:
  they can be renamed and get new default days, but keep their code, stay
  active and cannot be deleted. A type used by a leave request cannot be
  deleted (make it inactive instead).

App:

- Settings → Company Profile (admins edit, managers read):
  `lib/company-profile.ts` (server actions), `lib/company-profile-file.ts`
  (checks and colours, tested in `company-profile.test.ts`).
- Settings → Leave Policy (admins edit, managers read): add, rename, change
  default days, deactivate, delete (`lib/leave-policy.ts`,
  `lib/leave-policy-file.ts`, tested in `leave-policy.test.ts`). A new type
  gives every current employee its default days; changing the default only
  affects people invited afterwards. Custom types get a `CUSTOM_…` code and
  cannot use a name the app reads as annual, sick, parental or unpaid leave.
  Inactive types are hidden from the leave request form.
- The workspace loads the company with everything else (`loadWorkspace` in
  `app/page.tsx`) and shares it through `CompanyContext`
  (`components/primitives.tsx`): logo and name in the menus, payslip
  header, invite form's default leave rate.
- Brand colour: main buttons and logo marks always; the design system's
  accent colour (links, active menu) only when the colour is readable on
  white, otherwise it stays the default blue (`brandTheme`).
- Before sign-in there is no company: the product name **RHFlow** is shown.
- Employer details for payslips (address, matricule fiscal, CNSS number)
  stay in Payroll → Rates & bonuses (`payroll_company`, per company since
  step 2).

Fixed in step 3: `company_row_guard` (`01_foundation.sql`) failed on every
edit of a leave type or event; re-run `01_foundation.sql` on databases set
up before.

Deferred from step 3:

- Timezone: every attendance and payroll function, and the Tunisian payroll
  rules, assume `Africa/Tunis` (`attendance_settings` only allows it).
- A logo for RHFlow itself (the sign-in screen shows a letter mark).

## Step 4: what exists

Roles, the same for every company:

| | Owner | Admin | HR | Manager | Employee |
|---|---|---|---|---|---|
| Company profile, branding | ✓ | ✓ | | | |
| Leave policy, departments, events, schedules, work sites | ✓ | ✓ | ✓ | read | |
| Invite and edit people, balances | ✓ | ✓ | ✓ | read | own contact details |
| Approve leave, authorizations, corrections | everyone | everyone | everyone | their departments, not themselves | |
| Attendance reports, notices of new requests | everyone | everyone | everyone | their departments | own |
| Payroll | ✓ | ✓ | ✓ | | own payslips |
| Give the hr, manager, employee roles | ✓ | ✓ | | | |
| Make admins, transfer ownership | ✓ | | | | |

A manager's team is the employees of the departments whose `manager_id` is
them. The owner is unique per company, always active and never deleted; it
only changes through `transfer_ownership()` to an active admin.

Database ([`01_foundation.sql`](supabase/saas/01_foundation.sql) and the
feature scripts):

- Helpers `org_role()`, `is_org_owner()`, `is_org_admin()` (owner, admin),
  `is_org_hr()` (owner, admin, hr), `is_org_staff()` (+ manager),
  `can_manage_employee(id)` (hr and above: the company; manager: their
  departments, never themselves). Every rule on employee rows (requests,
  balances, authorizations, punches, corrections, schedule assignments,
  audits, rate history, leave attachments) uses `can_manage_employee`.
- `employees_role_check`, one owner per company (`employees_one_owner_per_org`),
  and `employees_guard`: who may change a role or a status
  (`ROLE_NOT_ALLOWED`, `OWNER_TRANSFER_ONLY`, `OWNER_CANNOT_BE_DEACTIVATED`).
- New companies start with an owner (sign-up and `create_organization`).
  Companies from before step 4: the earliest active admin becomes the owner.
- `notice_reviewer()` (notifications.sql) picks who hears about a new
  request; `payroll_is_admin()` now means owner, admin or hr.
- Authorizations can be deleted with the user's own client (own pending, or
  managed); the app no longer uses the service role for request deletions.

App: [`lib/roles.ts`](lib/roles.ts) (tested in `roles.test.ts`) holds the
same rules for server actions, the middleware and the screens;
`WorkspaceAccess` (built in `app/page.tsx`) tells each screen what the
signed-in person may do. Managers see approve buttons only for their team,
a read-only employee panel, Settings without the Attendance tab, no
Payroll. The employee panel offers only the roles you may give, locks the
owner's and (for admins) other admins' status, and lets the owner hand
ownership to an admin ("Make owner"). Approvals report an error when the
database blocks them instead of showing "Approved".

Known trade-off: approving leave deducts the balance from the approver's
browser session, so a manager may write their team's `leave_balances`
(only HR and above can edit balances in the app). Moving the approval into
one database function would remove that.

Still open (later steps):

- Avatars are in a public bucket: a photo URL works for anyone who has it
  (the path is the employee id).
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
   10. `supabase/saas/03_company_settings.sql`

   Do **not** run `handle_new_user.sql` or `leave_types.sql`: they are for
   single-company databases and now stop with an error on a company
   database.
   On a project set up before step 2, run the same list again in the same
   order: the scripts migrate what is there.
2. Run `supabase/saas/tests/01_isolation.sql`,
   `supabase/saas/tests/02_isolation.sql`,
   `supabase/saas/tests/03_isolation.sql` and
   `supabase/saas/tests/04_roles.sql`. They must end with
   `All isolation checks passed`, `All step 2 isolation checks passed`,
   `All step 3 checks passed` and `All step 4 role checks passed`.
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
attendance and payroll data to that company), then the isolation tests.
Deploy the app from this branch at the same time: it saves employer details
per company.
