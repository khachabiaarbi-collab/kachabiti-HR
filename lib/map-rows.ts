import type {
  Authorization,
  CompanyEvent,
  Department,
  Employee,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  Notice,
  Role,
} from "@/lib/app-types";

export const AUTHORIZATION_FREE_MINUTES = 480;

const AVATAR_COLORS = [
  "avatar-indigo",
  "avatar-teal",
  "avatar-amber",
  "avatar-rose",
  "avatar-slate",
];

function unwrap<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function parseDay(iso: string) {
  return new Date(`${iso}T00:00:00`);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function initialsFromName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return initials || "?";
}

export function firstName(name: string) {
  return name.trim().split(/\s+/).filter(Boolean)[0] ?? name;
}

function colorForId(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash + id.charCodeAt(i)) % AVATAR_COLORS.length;
  }
  return AVATAR_COLORS[hash];
}

export function displayRole(role: string) {
  if (role === "admin") return "Administrator";
  if (role === "manager") return "Manager";
  if (role === "Administrator" || role === "Manager" || role === "Employee") {
    return role;
  }
  return "Employee";
}

export function toUiRole(role: string | undefined, fallback: Role): Role {
  const value = (role || "").toLowerCase();
  if (value === "manager") return "Manager";
  if (value === "admin" || value === "administrator") return "Admin";
  if (value === "employee") return "Employee";
  return fallback;
}

export function displayLeaveType(name: string) {
  if (/leave|إجازة/i.test(name)) return name;
  return `${name} leave`;
}

export function leaveTypeTone(name: string) {
  const type = { name };
  if (isAnnualLeaveType(type)) return "type-vacation";
  if (isSickLeaveType(type)) return "type-sick";
  if (isParentalLeaveType(type)) return "type-parental";
  if (isExceptionalLeaveType(type)) return "type-exceptional";
  if (/unpaid/i.test(name)) return "type-unpaid";
  return "type-other";
}

function titleStatus(status: string): LeaveRequest["status"] {
  const value = status.toLowerCase();
  if (value === "approved") return "Approved";
  if (value === "rejected") return "Rejected";
  return "Pending";
}

function formatDateRange(start: string, end: string) {
  const from = parseDay(start);
  const to = parseDay(end);
  const monthDay: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (start === end) {
    return from.toLocaleDateString("en-US", { ...monthDay, year: "numeric" });
  }
  return `${from.toLocaleDateString("en-US", monthDay)} – ${to.toLocaleDateString("en-US", { ...monthDay, year: "numeric" })}`;
}

function inclusiveDays(start: string, end: string) {
  const days = requestedLeaveDays(start, end);
  return days === 1 ? "1 day" : `${days} days`;
}

export function requestedLeaveDays(start: string, end: string) {
  const from = parseDay(start);
  const to = parseDay(end);
  return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
}

function relativeTime(iso: string) {
  const then = new Date(iso).getTime();
  const delta = Math.round((Date.now() - then) / 1000);
  if (Number.isNaN(then) || delta < 45) return "Just now";
  const minutes = Math.round(delta / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function noticeKind(type: string): Notice["kind"] {
  const value = type.toLowerCase();
  if (value.includes("approv")) return "approved";
  if (value.includes("reject")) return "rejected";
  if (value.includes("pend") || value.includes("submit")) return "pending";
  return "reminder";
}

export type EmployeeRow = {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  job_title: string | null;
  start_date: string | null;
  monthly_leave_days?: number | string | null;
  avatar_url: string | null;
  department_id: string | null;
};

export function displayValue(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
}

export function formatDisplayDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const date = parseDay(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function mapEmployee(row: EmployeeRow, departmentName = "Unassigned"): Employee {
  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    department: departmentName,
    departmentId: row.department_id,
    jobTitle: row.job_title,
    role: displayRole(row.role),
    status: row.status === "inactive" ? "Inactive" : "Active",
    startDate: row.start_date,
    monthlyLeaveDays:
      row.monthly_leave_days == null || row.monthly_leave_days === ""
        ? null
        : Number(row.monthly_leave_days) || null,
    avatarUrl: row.avatar_url,
    initials: initialsFromName(row.full_name),
    color: colorForId(row.id),
  };
}

export type DepartmentRow = {
  id: string;
  name: string;
  manager_id: string | null;
};

export function mapDepartment(
  row: DepartmentRow,
  employees: Employee[],
  employeeRows: EmployeeRow[],
): Department {
  const count = employeeRows.filter((employee) => employee.department_id === row.id).length;
  const manager =
    employees.find((employee) => employee.id === row.manager_id)?.name ?? "Unassigned";
  return {
    id: row.id,
    name: row.name,
    manager,
    count,
  };
}

export type LeaveRequestRow = {
  id: string;
  employee_id: string;
  leave_type_id?: string | null;
  start_date: string;
  end_date: string;
  status: string;
  reason?: string | null;
  created_at?: string | null;
  approver_id?: string | null;
  attachment_path?: string | null;
  attachment_name?: string | null;
  employees?: { full_name: string } | { full_name: string }[] | null;
  leave_types?: { name: string } | { name: string }[] | null;
};

function parseTimeParts(value: string) {
  const [hours = "0", minutes = "0"] = value.split(":");
  return {
    hours: Number(hours) || 0,
    minutes: Number(minutes.slice(0, 2)) || 0,
  };
}

export function formatClock(value: string) {
  const { hours, minutes } = parseTimeParts(value);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function minutesBetweenTimes(start: string, end: string) {
  const from = parseTimeParts(start);
  const to = parseTimeParts(end);
  return to.hours * 60 + to.minutes - (from.hours * 60 + from.minutes);
}

export function formatDurationMinutes(minutes: number) {
  const safe = Math.max(0, Math.round(minutes));
  if (safe === 0) return "0h";
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

export function authorizationBucketLabel(minutes: number) {
  return `${formatDurationMinutes(minutes)} of ${AUTHORIZATION_FREE_MINUTES / 60}h`;
}

export function authorizationBalance(usedMinutes: number) {
  const capMinutes = AUTHORIZATION_FREE_MINUTES;
  const remainingMinutes = Math.max(0, capMinutes - usedMinutes);
  const extraMinutes = Math.max(0, usedMinutes - capMinutes);
  const daysCharged = Math.max(0, Math.ceil(usedMinutes / capMinutes) - 1);
  return {
    capMinutes,
    usedMinutes,
    remainingMinutes,
    extraMinutes,
    daysCharged,
    usedLabel: authorizationBucketLabel(usedMinutes),
    usedDurationLabel: formatDurationMinutes(usedMinutes),
    remainingLabel: formatDurationMinutes(remainingMinutes),
    extraLabel: formatDurationMinutes(extraMinutes),
  };
}

export function authorizationVacationDaysToCharge(
  usedBeforeMinutes: number,
  additionalMinutes: number,
) {
  return (
    authorizationBalance(usedBeforeMinutes + additionalMinutes).daysCharged -
    authorizationBalance(usedBeforeMinutes).daysCharged
  );
}

export function authorizationMonthKey(isoDate: string) {
  return isoDate.slice(0, 7);
}

export function currentAuthorizationMonthKey(asOf = new Date()) {
  return isoDate(asOf).slice(0, 7);
}

export function approvedAuthorizationMinutes(
  items: Authorization[],
  employeeId: string,
  monthKey = currentAuthorizationMonthKey(),
) {
  return items
    .filter(
      (item) =>
        item.employeeId === employeeId &&
        item.status === "Approved" &&
        authorizationMonthKey(item.date) === monthKey,
    )
    .reduce((sum, item) => sum + item.durationMinutes, 0);
}

export type AuthorizationRow = {
  id: string;
  employee_id: string;
  date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number | string;
  reason: string;
  status: string;
  created_at?: string | null;
  approver_id?: string | null;
  employees?: { full_name: string } | { full_name: string }[] | null;
};

export function mapAuthorization(
  row: AuthorizationRow,
  departmentName = "Unassigned",
): Authorization {
  const employee = unwrap(row.employees);
  const durationMinutes = Number(row.duration_minutes) || 0;
  return {
    id: row.id,
    employeeId: row.employee_id,
    name: employee?.full_name ?? "Unknown",
    department: departmentName,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMinutes,
    durationLabel: formatDurationMinutes(durationMinutes),
    timesLabel: `${formatClock(row.start_time)}–${formatClock(row.end_time)}`,
    reason: row.reason.trim(),
    status: titleStatus(row.status),
    createdAt: row.created_at ?? null,
    approverId: row.approver_id ?? null,
  };
}

export function mapLeaveRequest(
  row: LeaveRequestRow,
  departmentName = "Unassigned",
): LeaveRequest {
  const employee = unwrap(row.employees);
  const leaveType = unwrap(row.leave_types);
  return {
    id: row.id,
    employeeId: row.employee_id,
    leaveTypeId: row.leave_type_id ?? null,
    name: employee?.full_name ?? "Unknown",
    type: displayLeaveType(leaveType?.name ?? "Leave"),
    dates: formatDateRange(row.start_date, row.end_date),
    days: inclusiveDays(row.start_date, row.end_date),
    department: departmentName,
    status: titleStatus(row.status),
    startDate: row.start_date,
    endDate: row.end_date,
    reason: row.reason?.trim() || null,
    createdAt: row.created_at ?? null,
    approverId: row.approver_id ?? null,
    attachmentPath: row.attachment_path ?? null,
    attachmentName: row.attachment_name ?? null,
  };
}

export type LeaveBalanceRow = {
  employee_id: string;
  leave_type_id: string;
  days_remaining: number | string;
  leave_types?: { name: string } | { name: string }[] | null;
};

export function mapLeaveBalance(row: LeaveBalanceRow): LeaveBalance {
  const leaveType = unwrap(row.leave_types);
  return {
    employeeId: row.employee_id,
    leaveTypeId: row.leave_type_id,
    typeName: leaveType?.name ?? "Leave",
    daysRemaining: Number(row.days_remaining) || 0,
  };
}

export type LeaveTypeRow = {
  id: string;
  name: string;
  default_days: number;
  code?: string | null;
};

export function mapLeaveType(row: LeaveTypeRow): LeaveType {
  return {
    id: row.id,
    name: row.name,
    defaultDays: Number(row.default_days) || 0,
    code: row.code ?? null,
  };
}

export function employeeBalances(
  balances: LeaveBalance[],
  employeeId: string,
) {
  return balances.filter((balance) => balance.employeeId === employeeId);
}

export function mergeEmployeeSolde(
  leaveTypes: LeaveType[],
  balances: LeaveBalance[],
  employeeId: string,
): LeaveBalance[] {
  const mine = employeeBalances(balances, employeeId);
  if (!leaveTypes.length) return mine;
  return leaveTypes.map((type) => {
    const existing = mine.find((balance) => balance.leaveTypeId === type.id);
    return {
      employeeId,
      leaveTypeId: type.id,
      typeName: type.name,
      daysRemaining: existing?.daysRemaining ?? 0,
    };
  });
}

export function isUnpaidLeaveType(type: Pick<LeaveType, "name" | "defaultDays">) {
  return type.defaultDays <= 0 || /unpaid/i.test(type.name);
}

export function soldeGoesNegative(
  remaining: number,
  requestedDays: number,
) {
  return remaining - requestedDays < 0;
}

export const DEFAULT_MONTHLY_LEAVE_DAYS = 1.75;

function leaveTypeCode(type: { code?: string | null }) {
  return (type.code ?? "").trim().toUpperCase();
}

export function isAnnualLeaveType(type: Pick<LeaveType, "name"> & { code?: string | null }) {
  const code = leaveTypeCode(type);
  if (code === "VACATION" || code === "ANNUAL") return true;
  return /annual|vacation|سنوي/i.test(type.name);
}

export function isSickLeaveType(type: Pick<LeaveType, "name"> & { code?: string | null }) {
  if (leaveTypeCode(type) === "SICK") return true;
  return /sick|مرض/i.test(type.name);
}

export function isParentalLeaveType(type: Pick<LeaveType, "name"> & { code?: string | null }) {
  if (leaveTypeCode(type) === "PARENTAL") return true;
  return /parental|paternel|paternity|maternity|maternit|أبوة|أمومة/i.test(type.name);
}

export function isExceptionalLeaveType(
  type: Pick<LeaveType, "name"> & { code?: string | null },
) {
  if (leaveTypeCode(type).startsWith("EXCEPTIONAL")) return true;
  return /وفاة|زواج|ختان|exceptional/i.test(type.name);
}

export const FIRST_PARENTAL_MONTHS = 3.5;
export const SECOND_PARENTAL_MONTHS = 4;

export function parseMonthlyLeaveDays(
  value: string | number | null | undefined,
) {
  const parsed =
    typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MONTHLY_LEAVE_DAYS;
  return parsed;
}

export function monthsWorkedSinceHire(
  startDate: string | null | undefined,
  asOf = new Date(),
) {
  if (!startDate) return 0;
  const start = parseDay(startDate);
  if (Number.isNaN(start.getTime())) return 0;
  const today = new Date(asOf);
  today.setHours(0, 0, 0, 0);
  if (start > today) return 0;
  return (
    (today.getFullYear() - start.getFullYear()) * 12 +
    (today.getMonth() - start.getMonth()) +
    1
  );
}

export function entitlementDays(
  defaultDays: number,
  startDate: string | null | undefined,
  monthlyRate?: number | null,
  asOf = new Date(),
) {
  const rate =
    monthlyRate != null && Number.isFinite(monthlyRate) && monthlyRate > 0
      ? monthlyRate
      : defaultDays / 12;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const months = monthsWorkedSinceHire(startDate, asOf);
  const cap =
    monthlyRate != null && monthlyRate > 0 ? monthlyRate * 12 : defaultDays;
  return Math.min(cap, months * rate);
}

export function openingDaysForLeaveType(
  type: Pick<LeaveType, "name" | "defaultDays"> & { code?: string | null },
  startDate: string | null | undefined,
  monthlyLeaveDays?: number | null,
  asOf = new Date(),
) {
  if (isUnpaidLeaveType(type)) return 0;
  if (isParentalLeaveType(type)) return 0;
  if (isAnnualLeaveType(type)) {
    return entitlementDays(
      type.defaultDays,
      startDate,
      monthlyLeaveDays,
      asOf,
    );
  }
  return type.defaultDays;
}

export function soldeFromStartDate(
  leaveTypes: LeaveType[],
  employeeId: string,
  startDate: string | null | undefined,
  monthlyLeaveDays?: number | null,
): LeaveBalance[] {
  return leaveTypes.map((type) => ({
    employeeId,
    leaveTypeId: type.id,
    typeName: type.name,
    daysRemaining: openingDaysForLeaveType(
      type,
      startDate,
      monthlyLeaveDays,
    ),
  }));
}

export function hasStartedWork(
  startDate: string | null | undefined,
  asOf = new Date(),
) {
  if (!startDate) return false;
  const start = parseDay(startDate);
  if (Number.isNaN(start.getTime())) return false;
  const today = new Date(asOf);
  today.setHours(0, 0, 0, 0);
  return start <= today;
}

export function openingEmployeeSolde(
  leaveTypes: LeaveType[],
  balances: LeaveBalance[],
  employeeId: string,
  startDate: string | null | undefined,
  monthlyLeaveDays?: number | null,
) {
  const merged = mergeEmployeeSolde(leaveTypes, balances, employeeId);
  const looksLikeFullGrant =
    leaveTypes.length > 0 &&
    leaveTypes.every((type) => {
      const row = merged.find((item) => item.leaveTypeId === type.id);
      const days = row?.daysRemaining ?? 0;
      return days === 0 || days === type.defaultDays;
    });
  if (looksLikeFullGrant) {
    return soldeFromStartDate(leaveTypes, employeeId, startDate, monthlyLeaveDays);
  }
  return merged.map((row) => {
    const type = leaveTypes.find((item) => item.id === row.leaveTypeId);
    if (!type || isUnpaidLeaveType(type)) return row;
    const correct = openingDaysForLeaveType(
      type,
      startDate,
      monthlyLeaveDays,
    );
    if (isAnnualLeaveType(type)) {
      const oneDecimal = Math.round(correct * 10) / 10;
      if (row.daysRemaining === oneDecimal) {
        return { ...row, daysRemaining: correct };
      }
      return row;
    }
    const prorated = entitlementDays(type.defaultDays, startDate, null);
    const proratedOneDecimal = Math.round(prorated * 10) / 10;
    if (
      row.daysRemaining === prorated ||
      row.daysRemaining === proratedOneDecimal
    ) {
      return { ...row, daysRemaining: type.defaultDays };
    }
    return row;
  });
}

export function toDbRole(role: string) {
  const value = role.toLowerCase();
  if (value === "admin" || value === "administrator") return "admin";
  if (value === "manager") return "manager";
  return "employee";
}

export function toDbStatus(status: string) {
  return status.toLowerCase() === "inactive" ? "inactive" : "active";
}

export type EventRow = {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  type: string;
};

export function mapEvent(row: EventRow): CompanyEvent {
  return {
    id: row.id,
    title: row.title,
    startDate: row.start_date,
    endDate: row.end_date,
    type: row.type,
  };
}

export type NotificationRow = {
  id: string;
  type: string;
  message: string;
  read: boolean;
  created_at: string;
  leave_request_id?: string | null;
  authorization_id?: string | null;
};

export function mapNotice(row: NotificationRow): Notice {
  return {
    id: row.id,
    kind: noticeKind(row.type),
    text: row.message,
    time: relativeTime(row.created_at),
    read: row.read,
    createdAt: row.created_at,
    leaveRequestId: row.leave_request_id ?? null,
    authorizationId: row.authorization_id ?? null,
  };
}

export function mondayOf(date: Date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const day = start.getDay();
  start.setDate(start.getDate() + (day === 0 ? -6 : 1 - day));
  return start;
}

export function weekDays(weekStart: Date) {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

export function calendarFocusDate(events: CompanyEvent[], requests: LeaveRequest[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = [
    ...events.map((event) => event.startDate),
    ...requests.map((request) => request.startDate),
  ]
    .map(parseDay)
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  const upcoming = dates.find((date) => date >= today);
  return upcoming ?? dates[0] ?? today;
}

export function weekPlacement(
  startDate: string,
  endDate: string,
  weekStart: Date,
) {
  const start = parseDay(startDate);
  const end = parseDay(endDate);
  const weekEnd = addDays(weekStart, 6);
  if (end < weekStart || start > weekEnd) return null;
  const from = start < weekStart ? weekStart : start;
  const to = end > weekEnd ? weekEnd : end;
  const col = Math.round((from.getTime() - weekStart.getTime()) / 86400000) + 1;
  const span = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  return { col, span };
}

export function monthStartDate(year: number, monthIndex: number) {
  return parseDay(`${year}-${String(monthIndex + 1).padStart(2, "0")}-01`);
}

export function daysInMonth(year: number, monthIndex: number) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function monthPlacement(
  startDate: string,
  endDate: string,
  monthStart: Date,
  dayCount: number,
) {
  const start = parseDay(startDate);
  const end = parseDay(endDate);
  const monthEnd = addDays(monthStart, dayCount - 1);
  if (end < monthStart || start > monthEnd) return null;
  const from = start < monthStart ? monthStart : start;
  const to = end > monthEnd ? monthEnd : end;
  const col = Math.round((from.getTime() - monthStart.getTime()) / 86400000) + 1;
  const span = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  return { col, span };
}

export function overlapsDateRange(
  start: string,
  end: string,
  from: string,
  to: string,
) {
  if (from && end < from) return false;
  if (to && start > to) return false;
  return true;
}

export function isoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function sickLeaveMinIsoDate(asOf = new Date()) {
  return isoDate(new Date(asOf.getTime() - 48 * 60 * 60 * 1000));
}

export function shiftCalendarMonths(iso: string, months: number) {
  const start = parseDay(iso);
  if (Number.isNaN(start.getTime())) return "";
  const whole = Math.trunc(months);
  const fraction = months - whole;
  const end = new Date(start);
  end.setMonth(end.getMonth() + whole);
  if (fraction) {
    const days = Math.round(Math.abs(fraction) * 30);
    end.setDate(end.getDate() + (fraction < 0 ? -days : days));
  }
  return isoDate(end);
}

export function leaveEndFromStart(iso: string, months: number) {
  const shifted = shiftCalendarMonths(iso, months);
  if (!shifted) return "";
  const end = parseDay(shifted);
  end.setDate(end.getDate() - 1);
  const start = parseDay(iso);
  if (end < start) return isoDate(start);
  return isoDate(end);
}

export function nextIsoDate(iso: string) {
  const day = parseDay(iso);
  if (Number.isNaN(day.getTime())) return "";
  day.setDate(day.getDate() + 1);
  return isoDate(day);
}

export function firstParentalLeave(
  requests: Pick<LeaveRequest, "employeeId" | "status" | "type" | "startDate" | "endDate">[],
  employeeId: string | null,
) {
  if (!employeeId) return null;
  const mine = requests
    .filter(
      (request) =>
        request.employeeId === employeeId &&
        request.status !== "Rejected" &&
        isParentalLeaveType({ name: request.type }),
    )
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  return mine[0] ?? null;
}
