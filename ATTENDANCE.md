# Attendance and time clock

This document describes the attendance feature for employees, administrators,
managers, and maintainers.

## Setup

Run the SQL scripts in the Supabase SQL editor in this order:

1. The existing base schema that creates `employees`, `departments`, and leave
   tables.
2. [`supabase/authorizations.sql`](supabase/authorizations.sql).
3. [`supabase/attendance.sql`](supabase/attendance.sql).

`attendance.sql` is idempotent and creates the attendance tables, default work
schedule, row-level security policies, indexes, validation triggers, summary
functions, and transactional RPC functions.

The company timezone is fixed to `Africa/Tunis`. Punch instants are stored as
UTC `timestamptz` values and displayed in Tunis time.

## Default configuration

- Work days: Monday through Friday
- Work segments: 08:00–12:00 and 13:00–17:00
- Normal break: 12:00–13:00
- Grace period: 5 minutes
- Maximum sessions: 5 per employee per day
- Overnight schedule segments are not supported

Administrators and managers can edit the schedule from **Settings →
Attendance**. They can also create effective-dated employee assignments from
that screen. Assignment date ranges for the same employee cannot overlap.

## Employee workflow

Employees open **Time clock** from the desktop navigation or mobile header.

The page displays:

- Server-synchronized Tunis time
- Present, absent, locked, or incomplete state
- The next valid action: entry or exit
- First entry, last exit, worked duration, and session count
- Paired sessions and the raw punch timeline
- A warning when a previous day has an unmatched entry

The browser never sends a punch type or timestamp. It sends an idempotency key
and the latest punch ID displayed on screen. PostgreSQL captures the current
server time and derives the next action.

If a request times out, the employee can retry safely. The client reuses the
same idempotency key until it learns the result.

## Punch state machine

- No punch or latest punch is an exit: the next action is entry.
- Latest punch is an entry: the next action is exit.
- Five completed sessions: a new entry is blocked.
- A fifth open session can still be closed with an exit.
- An unmatched entry on a past date is marked incomplete.
- A new day can start even when an older day is incomplete.

Refreshes and page renders only read attendance. They never create punches.

## Correction workflow

Employees cannot directly edit attendance.

From the timeline they can request one of these operations:

- Add a missing entry or exit
- Change an existing punch type or time
- Void an accidental punch

A reason is mandatory. The requested timestamp must belong to the selected
Tunis work date.

Administrators and managers open **Attendance → Correction requests**. The
review panel shows the original timeline, proposed operation, proposed time,
and employee reason. The reviewer can approve or reject and optionally add a
note.

Approval is transactional. PostgreSQL:

1. Locks the employee and work date.
2. Applies the add, change, or soft void.
3. Rebuilds sequence numbers.
4. Rejects repeated types, invalid chronology, or more than ten events.
5. Writes an append-only audit record.

Rejection leaves attendance unchanged and records the decision in the audit
log.

Correction submissions notify administrators and managers in the in-app bell.
Approval and rejection notify the employee. Opening an attendance notice takes
staff to **Attendance → Correction requests** and employees to **Time clock**.
Immediate punch results still use the toast only.

## Admin attendance view

The **Attendance** screen is available to `admin` and `manager` roles.

The records tab supports:

- Date ranges up to 93 inclusive calendar days
- Employee, department, and computed-state filters
- Paginated employee/day summaries
- First and last punch, worked duration, and session count
- Expandable raw timeline, resolved schedule, and approved authorizations

The correction tab supports pending, approved, rejected, or all requests.

## Schedule resolution

For each attendance date, the system uses:

1. The active employee assignment whose effective range contains the date.
2. Otherwise, the active company default schedule.

Schedules contain same-day `work` and `break` segments. Segments on the same
weekday cannot overlap. Exactly one company default schedule must remain.

Punching is still allowed on weekends and unscheduled days. Such attendance is
reported as unscheduled work rather than rejected.

## Authorizations

Attendance and hour-based authorizations remain separate records.

- An authorization never creates, moves, or closes a punch.
- Approved authorizations for the work date are returned with attendance
  summaries for HR review.
- Attendance does not change authorization balances or vacation deductions.
- Raw punch times are always preserved.

## Database objects

Main tables:

- `attendance_settings`: singleton timezone, grace, and session configuration
- `work_schedules`: schedule templates
- `work_schedule_segments`: weekday work and break windows
- `employee_schedule_assignments`: effective-dated employee overrides
- `attendance_punches`: immutable server-time punch ledger with soft voiding
- `attendance_correction_requests`: employee proposals and reviewer decisions
- `attendance_audit_log`: append-only correction audit history

Main RPC functions:

- `attendance_today()`: employee state and previous incomplete-day warning
- `attendance_day_summary(employee, date, as_of)`: canonical daily summary
- `punch_attendance(idempotency_key, expected_latest_punch_id)`: atomic punch
- `attendance_report(...)`: bounded staff report
- `apply_attendance_correction(request_id, decision, note)`: atomic review
- `save_work_schedule(schedule, segments, assignments, settings)`: atomic
  schedule maintenance

## HTTP API

Employee endpoints:

- `GET /api/attendance/today`
- `POST /api/attendance/punch`
- `GET /api/attendance/correction-requests`
- `POST /api/attendance/correction-requests`

Staff endpoints:

- `GET /api/attendance`
- `POST /api/attendance/correction-requests/[id]/decision`
- `GET /api/work-schedules`
- `PUT /api/work-schedules`

Every route authenticates with `supabase.auth.getUser()` and loads the current
`employees` profile. Staff routes require role `admin` or `manager`. Inactive
profiles are rejected.

Stable API errors include `STALE_STATE`, `MAX_SESSIONS`, `INVALID_SEQUENCE`,
`FORBIDDEN`, `UNAUTHENTICATED`, `INVALID_REQUEST`, and `SERVER_ERROR`.

## Security and integrity

- Employees can read only their own punches and correction requests.
- Administrators and managers can read company-wide attendance.
- Direct punch insert, update, and delete are revoked.
- Database server time is authoritative.
- Transaction advisory locks serialize changes per employee and work date.
- Unique idempotency keys make network retries safe.
- Latest-punch tokens prevent stale tabs from creating the opposite action.
- Correction approval shares the same locking strategy.
- Audit rows cannot be changed or deleted by authenticated clients.
- The service-role key is not used by browser attendance code.

## Important files

- [`supabase/attendance.sql`](supabase/attendance.sql)
- [`lib/attendance.ts`](lib/attendance.ts)
- [`lib/attendance-server.ts`](lib/attendance-server.ts)
- [`lib/attendance-api.ts`](lib/attendance-api.ts)
- [`components/attendance-views.tsx`](components/attendance-views.tsx)
- [`app/api/attendance`](app/api/attendance)
- [`app/api/work-schedules/route.ts`](app/api/work-schedules/route.ts)

## Troubleshooting

If Time clock or Attendance reports a missing relation or RPC, run
`supabase/attendance.sql` after `supabase/authorizations.sql`.

If an employee is forbidden, verify that `employees.id` equals their Auth user
ID and that `employees.status` is not `inactive`.

If a manager cannot access staff attendance, verify that the database role is
the lowercase value `manager`.

If a correction cannot be approved, inspect its proposed sequence. The
resulting day must alternate entry and exit, contain at most ten events, and
have strictly increasing timestamps.

If a schedule cannot be saved, check for overlapping weekday segments,
overlapping employee assignment ranges, invalid date ranges, or removal of the
only default schedule.
