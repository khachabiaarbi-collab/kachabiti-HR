import { AUTHORIZATION_DAY_HOURS } from "./leave-accrual";

const DEFAULT_MONTHLY_LEAVE_DAYS = 1.5;

type LeaveTypeRef = {
  id?: string;
  name: string;
  defaultDays?: number;
  code?: string | null;
};

type RequestRef = {
  id: string;
  employeeId: string;
  leaveTypeId: string | null;
  name: string;
  type: string;
  department: string;
  status: string;
  startDate: string;
  endDate: string;
};

type EmployeeRef = {
  id: string;
  department: string;
  status: string;
  startDate: string | null;
  monthlyLeaveDays: number | null;
};

function requestedLeaveDays(start: string, end: string) {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return Math.round((to - from) / 86400000) + 1;
}

function daysInMonth(year: number, monthIndex: number) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function isUnpaidLeave(type: LeaveTypeRef) {
  return (type.defaultDays ?? 1) <= 0 || /unpaid/i.test(type.name);
}

function isAnnualLeave(type: LeaveTypeRef) {
  const code = (type.code ?? "").trim().toUpperCase();
  if (code === "VACATION" || code === "ANNUAL") return true;
  return /annual|vacation|سنوي/i.test(type.name);
}

function isSickLeave(type: LeaveTypeRef) {
  if ((type.code ?? "").trim().toUpperCase() === "SICK") return true;
  return /sick|مرض/i.test(type.name);
}

export type LeaveKind = "annual" | "sick" | "unpaid" | "other";

export type AnalyticsPerson = {
  id: string;
  employeeId: string;
  name: string;
  department: string;
  type: string;
  startDate: string;
  endDate: string;
};

export type LeaveAnalytics = {
  year: number;
  daysTaken: number;
  annualDaysTaken: number;
  entitlement: number;
  utilization: number;
  approvedCount: number;
  decidedCount: number;
  approvalRate: number;
  averageDays: number;
  pendingCount: number;
  monthDays: number[];
  byKind: { kind: LeaveKind; days: number }[];
  byDepartment: { name: string; days: number }[];
  onLeave: AnalyticsPerson[];
  upcoming: AnalyticsPerson[];
  authorizationHours: number;
  authorizationDays: number;
  authorizationCount: number;
};

const KINDS: LeaveKind[] = ["annual", "sick", "unpaid", "other"];

export function addIsoDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysOverlapping(
  start: string,
  end: string,
  from: string,
  to: string,
): number {
  if (end < from || start > to) return 0;
  const first = start < from ? from : start;
  const last = end > to ? to : end;
  return requestedLeaveDays(first, last);
}

export function emptyMonthDays(): number[] {
  return Array.from({ length: 12 }, () => 0);
}

export function addMonthDays(left: number[], right: number[]): number[] {
  return emptyMonthDays().map((_, index) => (left[index] ?? 0) + (right[index] ?? 0));
}

export function monthDaysInYear(start: string, end: string, year: number): number[] {
  return emptyMonthDays().map((_, index) => {
    const month = String(index + 1).padStart(2, "0");
    const from = `${year}-${month}-01`;
    const to = `${year}-${month}-${String(daysInMonth(year, index)).padStart(2, "0")}`;
    return daysOverlapping(start, end, from, to);
  });
}

export function monthsEmployedInYear(
  startDate: string | null,
  year: number,
  asOf: string,
): number {
  const yearFrom = `${year}-01-01`;
  const yearTo = `${year}-12-31`;
  if (asOf < yearFrom) return 0;
  const hire = !startDate || startDate < yearFrom ? yearFrom : startDate;
  if (hire > yearTo || hire > asOf) return 0;
  const first = Number(hire.slice(5, 7));
  const lastIso = asOf < yearTo ? asOf : yearTo;
  const last = Number(lastIso.slice(5, 7));
  return Math.max(0, last - first + 1);
}

export function annualEntitlementForYear(
  employee: Pick<EmployeeRef, "status" | "startDate" | "monthlyLeaveDays">,
  year: number,
  asOf: string,
): number {
  if (employee.status === "Inactive") return 0;
  const rate =
    employee.monthlyLeaveDays != null && employee.monthlyLeaveDays > 0
      ? employee.monthlyLeaveDays
      : DEFAULT_MONTHLY_LEAVE_DAYS;
  return monthsEmployedInYear(employee.startDate, year, asOf) * rate;
}

export function leaveKindFromType(type: LeaveTypeRef | null): LeaveKind {
  if (!type) return "other";
  if (isUnpaidLeave(type)) return "unpaid";
  if (isAnnualLeave(type)) return "annual";
  if (isSickLeave(type)) return "sick";
  return "other";
}

export function leaveKindForRequest(
  request: Pick<RequestRef, "leaveTypeId" | "type">,
  leaveTypes: LeaveTypeRef[],
): LeaveKind {
  const typed = leaveTypes.find((type) => type.id === request.leaveTypeId);
  return leaveKindFromType(typed ?? { name: request.type, defaultDays: 1 });
}

export function utilizationPercent(taken: number, entitled: number): number {
  if (entitled <= 0) return 0;
  return Math.round((taken / entitled) * 100);
}

export function toAnalyticsPerson(
  request: Pick<
    RequestRef,
    "id" | "employeeId" | "name" | "department" | "type" | "startDate" | "endDate"
  >,
): AnalyticsPerson {
  return {
    id: request.id,
    employeeId: request.employeeId,
    name: request.name,
    department: request.department,
    type: request.type,
    startDate: request.startDate,
    endDate: request.endDate,
  };
}

export function peopleOnLeave(
  requests: RequestRef[],
  today: string,
): AnalyticsPerson[] {
  return requests
    .filter(
      (request) =>
        request.status === "Approved" &&
        request.startDate <= today &&
        request.endDate >= today,
    )
    .map(toAnalyticsPerson)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function peopleUpcoming(
  requests: RequestRef[],
  today: string,
  days = 14,
): AnalyticsPerson[] {
  const until = addIsoDays(today, days);
  return requests
    .filter(
      (request) =>
        request.status === "Approved" &&
        request.startDate > today &&
        request.startDate <= until,
    )
    .map(toAnalyticsPerson)
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
}

export function authorizationTotals(
  authorizations: { date: string; status: string; durationMinutes: number }[],
  year: number,
): { hours: number; days: number; count: number } {
  const prefix = String(year);
  const approved = authorizations.filter(
    (row) => row.status === "Approved" && row.date.startsWith(prefix),
  );
  const minutes = approved.reduce(
    (total, row) => total + Math.max(0, row.durationMinutes),
    0,
  );
  const hours = Math.round((minutes / 60) * 100) / 100;
  return {
    hours,
    days: Math.round((hours / AUTHORIZATION_DAY_HOURS) * 100) / 100,
    count: approved.length,
  };
}

export function analyticsYearOptions(isoDates: string[], currentYear: number): number[] {
  const years = new Set<number>([currentYear]);
  for (const iso of isoDates) {
    const year = Number(iso.slice(0, 4));
    if (Number.isInteger(year) && year >= 2000 && year <= currentYear) years.add(year);
  }
  return [...years].sort((left, right) => right - left);
}

function departmentOf(
  request: Pick<RequestRef, "employeeId" | "department">,
  employees: Pick<EmployeeRef, "id" | "department">[],
): string {
  return employees.find((employee) => employee.id === request.employeeId)?.department
    || request.department
    || "Unassigned";
}

export function groupDaysByKind(
  requests: RequestRef[],
  leaveTypes: LeaveTypeRef[],
  yearFrom: string,
  yearTo: string,
): { kind: LeaveKind; days: number }[] {
  const totals: Record<LeaveKind, number> = { annual: 0, sick: 0, unpaid: 0, other: 0 };
  for (const request of requests) {
    totals[leaveKindForRequest(request, leaveTypes)] += daysOverlapping(
      request.startDate,
      request.endDate,
      yearFrom,
      yearTo,
    );
  }
  return KINDS.map((kind) => ({ kind, days: totals[kind] }));
}

export function groupDaysByDepartment(
  requests: RequestRef[],
  employees: Pick<EmployeeRef, "id" | "department">[],
  yearFrom: string,
  yearTo: string,
): { name: string; days: number }[] {
  const totals = new Map<string, number>();
  for (const request of requests) {
    const department = departmentOf(request, employees);
    totals.set(
      department,
      (totals.get(department) ?? 0) +
        daysOverlapping(request.startDate, request.endDate, yearFrom, yearTo),
    );
  }
  return [...totals.entries()]
    .map(([name, days]) => ({ name, days }))
    .sort((left, right) => right.days - left.days || left.name.localeCompare(right.name));
}

export function buildLeaveAnalytics(input: {
  year: number;
  today: string;
  requests: RequestRef[];
  employees: EmployeeRef[];
  leaveTypes: LeaveTypeRef[];
  authorizations: { date: string; status: string; durationMinutes: number }[];
}): LeaveAnalytics {
  const yearFrom = `${input.year}-01-01`;
  const yearTo = `${input.year}-12-31`;
  const inYear = (request: RequestRef) =>
    daysOverlapping(request.startDate, request.endDate, yearFrom, yearTo) > 0;
  const approved = input.requests.filter(
    (request) => request.status === "Approved" && inYear(request),
  );
  const decided = input.requests.filter(
    (request) => request.status !== "Pending" && inYear(request),
  );
  const daysTaken = approved.reduce(
    (total, request) =>
      total + daysOverlapping(request.startDate, request.endDate, yearFrom, yearTo),
    0,
  );
  const annualDaysTaken = approved
    .filter((request) => leaveKindForRequest(request, input.leaveTypes) === "annual")
    .reduce(
      (total, request) =>
        total + daysOverlapping(request.startDate, request.endDate, yearFrom, yearTo),
      0,
    );
  const entitlement = input.employees
    .filter((employee) => employee.status === "Active")
    .reduce(
      (total, employee) =>
        total + annualEntitlementForYear(employee, input.year, input.today),
      0,
    );
  const monthDays = approved.reduce(
    (months, request) =>
      addMonthDays(months, monthDaysInYear(request.startDate, request.endDate, input.year)),
    emptyMonthDays(),
  );
  const authz = authorizationTotals(input.authorizations, input.year);
  return {
    year: input.year,
    daysTaken,
    annualDaysTaken,
    entitlement,
    utilization: utilizationPercent(annualDaysTaken, entitlement),
    approvedCount: approved.length,
    decidedCount: decided.length,
    approvalRate: utilizationPercent(approved.length, decided.length),
    averageDays: approved.length > 0 ? daysTaken / approved.length : 0,
    pendingCount: input.requests.filter((request) => request.status === "Pending").length,
    monthDays,
    byKind: groupDaysByKind(approved, input.leaveTypes, yearFrom, yearTo),
    byDepartment: groupDaysByDepartment(approved, input.employees, yearFrom, yearTo),
    onLeave: peopleOnLeave(input.requests, input.today),
    upcoming: peopleUpcoming(input.requests, input.today),
    authorizationHours: authz.hours,
    authorizationDays: authz.days,
    authorizationCount: authz.count,
  };
}
