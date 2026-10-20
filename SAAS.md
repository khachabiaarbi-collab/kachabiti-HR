# RHFlow multi-company (SaaS)

Branch `feature/generic-saas` turns the single-company Kachabiti app into
RHFlow: one app and one Supabase database shared by many customer
companies, each seeing only its own data. Work happens step by step, each
step tested on a development project (`rhflow-dev`) before it reaches
production.

| Step | Scope | State |
|---|---|---|
| 1 | Companies, company on core tables, RLS, new-user trigger | **done** |
| 2 | Company on attendance, authorizations, payroll, notifications, storage | next |
| 3 | Per-company settings: name, logo, colors, CNSS / tax id, timezone, leave and payroll rules | |
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

Not isolated yet (step 2): attendance, authorizations, payroll, notifications
and the storage buckets. **Do not put two real companies in one database
before step 2.**

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
2. Run `supabase/saas/tests/01_isolation.sql`. It must end with
   `All isolation checks passed`. It runs in a transaction that is rolled
   back, so it leaves nothing behind.
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
`existing_company` in the script). Only do this after step 2 is ready and
tested, with a backup, and run the isolation test afterwards.
