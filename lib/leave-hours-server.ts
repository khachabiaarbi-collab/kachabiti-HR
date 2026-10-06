import "server-only";

import { ATTENDANCE_TIMEZONE } from "@/lib/attendance";
import {
  requireAttendanceAuth,
  AttendanceServerError,
  type AttendanceAuth,
} from "@/lib/attendance-server";
import {
  monthEnd,
  monthKey,
  monthLeaveHours,
  monthStart,
  punchedMinutesByEmployee,
  vacationBalanceDays,
  type DatedAuthorization,
  type DatedLeave,
  type LeaveHourSelf,
  type LeaveHourTeamItem,
  type LeavePunch,
} from "@/lib/leave-hours";
import {
  accrueLeave,
  rateForMonth,
  vacationBalance,
  type Accrual,
  type CreditWindowDay,
  type RateChange,
} from "@/lib/leave-accrual";
import { DEFAULT_MONTHLY_LEAVE_DAYS, isAnnualLeaveType, isUnpaidLeaveType } from "@/lib/map-rows";

type PunchRow = {
  employee_id: string;
  work_date: string;
  type: string;
  occurred_at: string;
  sequence_no: number;
};

type EmployeeRow = {
  id: string;
  full_name: string | null;
  start_date: string | null;
  monthly_leave_days: number | string | null;
  status: string | null;
};

function todayInTunis(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function asPunches(rows: PunchRow[]): LeavePunch[] {
  return rows
    .filter((row) => row.type === "entry" || row.type === "exit")
    .map((row) => ({
      employeeId: row.employee_id,
      workDate: String(row.work_date).slice(0, 10),
      type: row.type as "entry" | "exit",
      occurredAt: row.occurred_at,
      sequenceNo: Number(row.sequence_no) || 0,
    }));
}

async function selectPages<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const pageSize = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) {
      throw new AttendanceServerError("SERVER_ERROR", 500, error.message);
    }
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function loadEmployees(auth: AttendanceAuth, employeeId?: string) {
  const columns = "id, full_name, start_date, monthly_leave_days, status";
  const run = (select: string) => {
    let query = auth.supabase.from("employees").select(select);
    if (employeeId) query = query.eq("id", employeeId);
    return query;
  };
  const first = await run(columns);
  if (first.error && /monthly_leave_days/i.test(first.error.message)) {
    const fallback = await run("id, full_name, start_date, status");
    if (fallback.error) {
      throw new AttendanceServerError("SERVER_ERROR", 500, fallback.error.message);
    }
    return (fallback.data ?? []) as unknown as EmployeeRow[];
  }
  if (first.error) {
    throw new AttendanceServerError("SERVER_ERROR", 500, first.error.message);
  }
  return (first.data ?? []) as unknown as EmployeeRow[];
}

async function loadPunches(
  auth: AttendanceAuth,
  employeeId: string | null,
  from: string | null,
  to: string | null,
) {
  return selectPages<PunchRow>((start, end) => {
    let query = auth.supabase
      .from("attendance_punches")
      .select("employee_id, work_date, type, occurred_at, sequence_no")
      .is("voided_at", null)
      .order("occurred_at", { ascending: true })
      .range(start, end);
    if (employeeId) query = query.eq("employee_id", employeeId);
    if (from) query = query.gte("work_date", from);
    if (to) query = query.lte("work_date", to);
    return query;
  });
}

async function annualTypeIds(auth: AttendanceAuth) {
  const first = await auth.supabase.from("leave_types").select("id, name, code");
  const rows = first.error
    ? (
        await auth.supabase.from("leave_types").select("id, name")
      ).data
    : first.data;
  return new Set(
    (rows ?? [])
      .filter((type) =>
        isAnnualLeaveType({
          name: String(type.name ?? ""),
          code: "code" in type ? (type.code as string | null) : null,
        }),
      )
      .map((type) => String(type.id)),
  );
}

function rateOf(employee: EmployeeRow) {
  const rate = Number(employee.monthly_leave_days);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_MONTHLY_LEAVE_DAYS;
}

export async function getSelfLeaveHours(auth?: AttendanceAuth): Promise<LeaveHourSelf> {
  const session = auth ?? (await requireAttendanceAuth());
  const [employee] = await loadEmployees(session, session.userId);
  if (!employee) {
    throw new AttendanceServerError("FORBIDDEN", 403, "Employee profile not found.");
  }
  const [balance] = await computeBalances(session, [employee]);
  if (balance) {
    const today = todayInTunis();
    const month = balance.accrual.months.find((item) => item.month === monthKey(today));
    return {
      balanceDays: balance.balanceDays,
      monthlyRate: balance.monthlyRate,
      ledgerDays: balance.ledgerDays,
      earnedDays: balance.accrual.earnedDays,
      thisMonth: {
        month: monthKey(today),
        scheduledHours: month?.scheduledHours ?? 0,
        punchedHours: month?.creditedHours ?? 0,
        extraHours: 0,
        earnedDays: month?.earnedDays ?? 0,
        uncoveredAuthorizationHours: month?.uncoveredAuthorizationHours ?? 0,
        hourValueDays: month?.hourValueDays ?? 0,
      },
    };
  }
  return legacySelfLeaveHours(session);
}

/** Before leave_accrual.sql: earned from raw punched minutes only. */
async function legacySelfLeaveHours(session: AttendanceAuth): Promise<LeaveHourSelf> {
  const today = todayInTunis();
  const [employee] = await loadEmployees(session, session.userId);
  if (!employee) {
    throw new AttendanceServerError("FORBIDDEN", 403, "Employee profile not found.");
  }
  const start = employee.start_date?.slice(0, 10) ?? null;
  const punches = asPunches(
    await loadPunches(session, session.userId, start, today),
  );
  const punchedByDay =
    punchedMinutesByEmployee(punches, new Date()).get(session.userId) ??
    new Map<string, number>();
  const authorizations = await selectPages<{
    date: string | null;
    duration_minutes: number | null;
  }>((from, to) =>
    session.supabase
      .from("authorizations")
      .select("date, duration_minutes")
      .eq("employee_id", session.userId)
      .eq("status", "approved")
      .range(from, to),
  );
  const authRows: DatedAuthorization[] = authorizations.map((row) => ({
    date: String(row.date ?? "").slice(0, 10),
    durationMinutes: Number(row.duration_minutes) || 0,
  }));
  const annualIds = await annualTypeIds(session);
  const leaveRows = await selectPages<{
    start_date: string;
    end_date: string;
    leave_type_id: string;
    status: string;
  }>((from, to) =>
    session.supabase
      .from("leave_requests")
      .select("start_date, end_date, leave_type_id, status")
      .eq("employee_id", session.userId)
      .eq("status", "approved")
      .range(from, to),
  );
  const approvedAnnualLeave: DatedLeave[] = leaveRows
    .filter((row) => annualIds.has(String(row.leave_type_id)))
    .map((row) => ({
      startDate: String(row.start_date).slice(0, 10),
      endDate: String(row.end_date).slice(0, 10),
    }));
  const monthlyRate = rateOf(employee);
  return {
    balanceDays: vacationBalanceDays({
      startDate: start,
      throughDate: today,
      monthlyRate,
      punchedByDay,
      authorizations: authRows,
      approvedAnnualLeave,
    }),
    monthlyRate,
    thisMonth: monthLeaveHours({
      month: monthKey(today),
      startDate: start,
      throughDate: today,
      monthlyRate,
      punchedByDay,
      authorizations: authRows,
    }),
  };
}

export async function getTeamLeaveHours(month: string): Promise<LeaveHourTeamItem[]> {
  const auth = await requireAttendanceAuth(true);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new AttendanceServerError("INVALID_REQUEST", 400, "Choose a month.");
  }
  const today = todayInTunis();
  const through = month < monthKey(today) ? monthEnd(month) : today;
  const employees = (await loadEmployees(auth)).filter(
    (employee) => employee.status !== "inactive",
  );
  const punches = asPunches(
    await loadPunches(auth, null, monthStart(month), monthEnd(month)),
  );
  const punched = punchedMinutesByEmployee(punches, new Date());
  const authorizations = await selectPages<{
    employee_id: string;
    date: string;
    duration_minutes: number;
  }>((from, to) =>
    auth.supabase
      .from("authorizations")
      .select("employee_id, date, duration_minutes")
      .eq("status", "approved")
      .gte("date", monthStart(month))
      .lte("date", monthEnd(month))
      .range(from, to),
  );
  const byEmployee = new Map<string, DatedAuthorization[]>();
  for (const row of authorizations) {
    const list = byEmployee.get(row.employee_id) ?? [];
    list.push({
      date: String(row.date).slice(0, 10),
      durationMinutes: Number(row.duration_minutes) || 0,
    });
    byEmployee.set(row.employee_id, list);
  }
  return employees
    .map((employee) => ({
      employeeId: employee.id,
      employeeName: employee.full_name?.trim() || "Employee",
      ...monthLeaveHours({
        month,
        startDate: employee.start_date?.slice(0, 10) ?? null,
        throughDate: through,
        monthlyRate: rateOf(employee),
        punchedByDay: punched.get(employee.id) ?? new Map(),
        authorizations: byEmployee.get(employee.id) ?? [],
      }),
    }))
    .sort((left, right) => left.employeeName.localeCompare(right.employeeName));
}

// ---------------------------------------------------------------------------
// One vacation balance for everyone (supabase/leave_accrual.sql)
// ---------------------------------------------------------------------------

export type LeaveBalanceItem = {
  employeeId: string;
  /** leave_balances: opening balance entered by the admin minus approved deductions. */
  ledgerDays: number;
  balanceDays: number;
  monthlyRate: number;
  accrual: Accrual;
};

function nowInTunis(now = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: ATTENDANCE_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const holidayCache = new Map<number, Set<string>>();

async function holidaysFor(years: number[]) {
  const dates = new Set<string>();
  for (const year of years) {
    let set = holidayCache.get(year);
    if (!set) {
      set = new Set<string>();
      try {
        const response = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/TN`, {
          next: { revalidate: 86400 },
        });
        if (response.ok) {
          for (const row of (await response.json()) as { date?: string }[]) {
            if (row?.date) set.add(row.date.slice(0, 10));
          }
        }
      } catch {
        // Without the holiday list, holidays count as ordinary scheduled days.
      }
      holidayCache.set(year, set);
    }
    for (const date of set) dates.add(date);
  }
  return dates;
}

type WindowRow = {
  employee_id: string;
  work_date: string;
  scheduled_minutes: number;
  segments: CreditWindowDay["segments"] | null;
  sessions: CreditWindowDay["sessions"] | null;
  authorizations: CreditWindowDay["authorizations"] | null;
};

/** null when leave_accrual.sql is not installed yet. */
async function loadWindows(auth: AttendanceAuth, employeeId: string | null, from: string, to: string) {
  const byEmployee = new Map<string, CreditWindowDay[]>();
  for (let start = from; start <= to; start = addDays(start, 366)) {
    const end = addDays(start, 365) < to ? addDays(start, 365) : to;
    const { data, error } = await auth.supabase.rpc("attendance_credit_windows", {
      p_employee_id: employeeId,
      p_from: start,
      p_to: end,
    });
    if (error) return null;
    for (const row of (data ?? []) as WindowRow[]) {
      const days = byEmployee.get(row.employee_id) ?? [];
      days.push({
        date: String(row.work_date).slice(0, 10),
        scheduledMinutes: Number(row.scheduled_minutes) || 0,
        segments: row.segments ?? [],
        sessions: row.sessions ?? [],
        authorizations: row.authorizations ?? [],
      });
      byEmployee.set(row.employee_id, days);
    }
  }
  return byEmployee;
}

/**
 * Balance per employee. Returns [] when the accrual SQL is missing, so callers
 * can fall back to the previous calculation.
 */
async function computeBalances(auth: AttendanceAuth, employees: EmployeeRow[]): Promise<LeaveBalanceItem[]> {
  if (!employees.length) return [];
  const today = todayInTunis();
  const single = employees.length === 1 ? employees[0].id : null;

  // Nothing is earned before the first punch, so start at that month.
  const firstPunch = await auth.supabase
    .from("attendance_punches")
    .select("work_date")
    .is("voided_at", null)
    .in("employee_id", employees.map((employee) => employee.id))
    .order("work_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  const firstDate = (firstPunch.data as { work_date?: string } | null)?.work_date?.slice(0, 10) ?? today;
  const from = `${firstDate.slice(0, 7)}-01`;
  const to = monthEnd(monthKey(today));

  const windows = await loadWindows(auth, single, from, to);
  if (!windows) return [];

  const annualIds = await annualTypeIds(auth);
  const [ledgerRows, rateRows, leaveRows, typeRows] = await Promise.all([
    selectPages<{ employee_id: string; leave_type_id: string; days_remaining: number | string }>((start, end) => {
      let query = auth.supabase
        .from("leave_balances")
        .select("employee_id, leave_type_id, days_remaining")
        .range(start, end);
      if (single) query = query.eq("employee_id", single);
      return query;
    }),
    auth.supabase.from("leave_rate_changes").select("employee_id, effective_month, monthly_days"),
    selectPages<{ employee_id: string; start_date: string; end_date: string; leave_type_id: string | null }>(
      (start, end) => {
        let query = auth.supabase
          .from("leave_requests")
          .select("employee_id, start_date, end_date, leave_type_id")
          .eq("status", "approved")
          .gte("end_date", from)
          .range(start, end);
        if (single) query = query.eq("employee_id", single);
        return query;
      },
    ),
    auth.supabase.from("leave_types").select("id, name, default_days"),
  ]);

  const unpaidTypes = new Set(
    ((typeRows.data ?? []) as { id: string; name: string; default_days: number | null }[])
      .filter((type) => isUnpaidLeaveType({ name: type.name, defaultDays: Number(type.default_days) || 0 }))
      .map((type) => type.id),
  );
  const years = Array.from(
    { length: Number(today.slice(0, 4)) - Number(from.slice(0, 4)) + 1 },
    (_, index) => Number(from.slice(0, 4)) + index,
  );
  const holidays = await holidaysFor(years);
  const now = nowInTunis();

  return employees.map((employee) => {
    const ledgerDays = ledgerRows
      .filter((row) => row.employee_id === employee.id && annualIds.has(String(row.leave_type_id)))
      .reduce((total, row) => total + (Number(row.days_remaining) || 0), 0);
    const changes: RateChange[] = ((rateRows.data ?? []) as {
      employee_id: string;
      effective_month: string;
      monthly_days: number | string;
    }[])
      .filter((row) => row.employee_id === employee.id)
      .map((row) => ({ effectiveMonth: String(row.effective_month).slice(0, 10), monthlyDays: Number(row.monthly_days) }));
    const current = rateOf(employee);
    const paidLeave = new Set<string>();
    for (const row of leaveRows) {
      if (row.employee_id !== employee.id || (row.leave_type_id && unpaidTypes.has(row.leave_type_id))) continue;
      for (let date = row.start_date.slice(0, 10); date <= row.end_date.slice(0, 10); date = addDays(date, 1)) {
        paidLeave.add(date);
      }
    }
    const accrual = accrueLeave(windows.get(employee.id) ?? [], {
      employedFrom: employee.start_date?.slice(0, 10) ?? null,
      today,
      now,
      holidays,
      paidLeave,
      rateFor: (month) => rateForMonth(changes, month, current),
    });
    return {
      employeeId: employee.id,
      ledgerDays,
      balanceDays: vacationBalance(ledgerDays, accrual),
      monthlyRate: rateForMonth(changes, monthKey(today), current),
      accrual,
    };
  });
}

/** Admin / manager: every active employee's vacation balance. */
export async function getStaffLeaveBalances() {
  const auth = await requireAttendanceAuth(true);
  const employees = (await loadEmployees(auth)).filter((employee) => employee.status !== "inactive");
  const items = await computeBalances(auth, employees);
  return items.map(({ employeeId, ledgerDays, balanceDays, monthlyRate, accrual }) => ({
    employeeId,
    ledgerDays,
    earnedDays: accrual.earnedDays,
    uncoveredAuthorizationHours: accrual.uncoveredAuthorizationHours,
    balanceDays,
    monthlyRate,
  }));
}
