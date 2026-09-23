# Kachabiti leave management

Leave management app for Kachabiti. Next.js App Router (v0 export) plus Supabase Auth SSR. Agents should read this file before changing code.

## Stack

- Next.js 16 (App Router), React 19, TypeScript
- Tailwind CSS 4, shadcn/ui (`components.json`, `@/*` paths)
- Supabase: `@supabase/supabase-js` + `@supabase/ssr`

## Initialise

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill `.env.local` before using auth. Restart the dev server after changing env vars.

| `.env.local` | Supabase dashboard |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL (`SUPABASE_URL`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key (`SUPABASE_PUBLISHABLE_KEY`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret key (`SUPABASE_SECRET_KEY`) — required on Netlify for invites |
| `NEXT_PUBLIC_SITE_URL` | App origin used in invite emails (`http://localhost:3000` locally, `https://kachabiti-hr.netlify.app` on Netlify) |

Never commit `.env.local`. Never prefix the secret key with `NEXT_PUBLIC_`. `SUPABASE_JWKS_URL` is unused.

Scripts: `npm run dev` · `npm run build` · `npm start`

## Layout

```
app/page.tsx                 # App shell: auth vs admin/employee workspace
app/login|dashboard|admin|forgot-password|reset-password/page.tsx  # re-export app/page.tsx
components/auth-screen.tsx   # Sign in / forgot / reset
components/app-chrome.tsx    # Sidebar, employee nav, top bar
components/admin-views.tsx   # Admin screens
components/employee-views.tsx
components/attendance-views.tsx # Employee clock, staff reports/corrections, schedules
components/modals.tsx
components/primitives.tsx    # Button, Field, Logo, Avatar, …
lib/app-types.ts
lib/attendance*.ts           # Attendance DTOs, protected server/API helpers
lib/supabase/…               # browser, server, middleware clients
middleware.ts
```

Import clients from `@/lib/supabase/client` (Client Components) and `@/lib/supabase/server` (Server Components, actions, route handlers).

## Auth

Run [`supabase/handle_new_user.sql`](supabase/handle_new_user.sql) in the SQL editor so each Auth user gets an `employees` row. Then promote the first admin:

```sql
update public.employees set role = 'admin' where email = 'you@kachabiti.com';
```

In Authentication → URL configuration set Site URL to the live app `https://kachabiti-hr.netlify.app`. Redirect URLs must include both local and production:

- `https://kachabiti-hr.netlify.app/auth/callback`
- `https://kachabiti-hr.netlify.app/reset-password`
- `http://localhost:3000/auth/callback`
- `http://localhost:3000/reset-password`

On Netlify, set `NEXT_PUBLIC_SITE_URL=https://kachabiti-hr.netlify.app` and `SUPABASE_SERVICE_ROLE_KEY`. Invites use `inviteUserByEmail` (service role) and redirect to `/reset-password?welcome=1` so the hire sets a password, then land on `/dashboard?profile=1` when their role is `employee`. Optional Invite email template: `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite&next=/reset-password`. For reliable production mail, add custom SMTP under Authentication → Emails. If My profile cannot save phone, run [`supabase/employee_profile.sql`](supabase/employee_profile.sql). If Upload photo fails because the avatars bucket is missing, run [`supabase/employee_avatars.sql`](supabase/employee_avatars.sql). Hour-based authorizations: run [`supabase/authorizations.sql`](supabase/authorizations.sql). Attendance requires authorizations first, then [`supabase/attendance.sql`](supabase/attendance.sql); complete setup and operations are documented in [`ATTENDANCE.md`](ATTENDANCE.md). If approved time over 8h did not take a vacation day, run [`supabase/authorization_solde.sql`](supabase/authorization_solde.sql), then approve a pending authorization for that person so the missing day is applied. Seed the leave catalog with [`supabase/leave_types.sql`](supabase/leave_types.sql). If a new hire received the full 21 annual days before their start date, run [`supabase/employee_solde.sql`](supabase/employee_solde.sql). To allow solde below 0 (leave in advance), run [`supabase/solde_advance.sql`](supabase/solde_advance.sql). In-app leave/authorization notices: run [`supabase/notifications.sql`](supabase/notifications.sql) (adds table, triggers, and Realtime publication). Attendance correction notices are added by [`supabase/attendance.sql`](supabase/attendance.sql) when the `notifications` table already exists; re-run that script after notifications if the bell is missing attendance items. In Database → Replication, confirm `notifications` is in `supabase_realtime`.

[`middleware.ts`](middleware.ts) refreshes the session and routes by `employees.role`:

- Unauthenticated `/`, `/dashboard`, or `/admin` → `/login`
- `admin` / `manager` home = `/admin`; `employee` home = `/dashboard`
- Logged in on `/` or `/login` → their home
- No `employees` row → sign out and `/login?error=profile`
- Public: `/forgot-password`, `/reset-password`

Auth callback: [`app/auth/callback/route.ts`](app/auth/callback/route.ts). Cookie adapters must use only `getAll` / `setAll`. Redirects must copy cookies from the Supabase response.

`SUPABASE_SERVICE_ROLE_KEY` is for future server-only admin work. Do not create a browser client with it.

## Current product state

Login, logout, password recovery, workspace lists, leave requests, authorizations, attendance, and analytics read from Supabase. Employees punch from Time clock and request corrections; admin/manager review Attendance and maintain schedules in Settings. Attendance remains screen-local and is not loaded by `loadWorkspace()`. In-app screens use `history.pushState`. Do not treat sample credentials as the source of truth.

## Conventions

- Do not expand scope: no unrelated refactors or extra files
- Prefer editing the existing screen components under `components/` rather than duplicating UI
- TypeScript strict; match existing style in a file
- Do not log secrets or put them in `AGENTS.md` / `.env.example`
