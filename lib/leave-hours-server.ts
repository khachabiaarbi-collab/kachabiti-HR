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
import { DEFAULT_MONTHLY_LEAVE_DAYS, isAnnualLeaveType } from "@/lib/map-rows";

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
