import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addIsoDays,
  analyticsYearOptions,
  annualEntitlementForYear,
  authorizationTotals,
  buildLeaveAnalytics,
  daysOverlapping,
  groupDaysByDepartment,
  groupDaysByKind,
  leaveKindFromType,
  monthDaysInYear,
  monthsEmployedInYear,
  peopleOnLeave,
  peopleUpcoming,
  utilizationPercent,
} from "./analytics";

const annual = {
  id: "t-annual",
  name: "Annual leave",
  defaultDays: 18,
  code: "ANNUAL",
};
const sick = { id: "t-sick", name: "Sick leave", defaultDays: 10, code: "SICK" };
const unpaid = { id: "t-unpaid", name: "Unpaid leave", defaultDays: 0 };

function request(partial: {
  id?: string;
  employeeId?: string;
  leaveTypeId?: string | null;
  name?: string;
  type?: string;
  department?: string;
  status?: string;
  startDate: string;
  endDate: string;
}) {
  return {
    id: partial.id ?? "r1",
    employeeId: partial.employeeId ?? "e1",
    leaveTypeId: partial.leaveTypeId ?? annual.id,
    name: partial.name ?? "Amine",
    type: partial.type ?? "Annual leave",
    department: partial.department ?? "Studio",
    status: partial.status ?? "Approved",
    startDate: partial.startDate,
    endDate: partial.endDate,
  };
}

function employee(partial: {
  id?: string;
  name?: string;
  department?: string;
  status?: string;
  startDate?: string | null;
  monthlyLeaveDays?: number | null;
} = {}) {
  return {
    id: partial.id ?? "e1",
    name: partial.name ?? "Amine",
    department: partial.department ?? "Studio",
    status: partial.status ?? "Active",
    startDate: partial.startDate ?? "2026-01-01",
    monthlyLeaveDays: partial.monthlyLeaveDays ?? 1.5,
  };
}

test("daysOverlapping: clamps to the window and is zero outside", () => {
  assert.equal(daysOverlapping("2026-01-30", "2026-02-02", "2026-02-01", "2026-02-28"), 2);
  assert.equal(daysOverlapping("2026-03-01", "2026-03-03", "2026-02-01", "2026-02-28"), 0);
  assert.equal(daysOverlapping("2026-02-10", "2026-02-12", "2026-02-01", "2026-02-28"), 3);
});

test("monthDaysInYear: a leave that crosses December and January is split", () => {
  const days = monthDaysInYear("2025-12-30", "2026-01-02", 2026);
  assert.equal(days[0], 2);
  assert.equal(days.reduce((total, value) => total + value, 0), 2);
  const december = monthDaysInYear("2025-12-30", "2026-01-02", 2025);
  assert.equal(december[11], 2);
});

test("monthsEmployedInYear: hire date, current month, and a finished year", () => {
  assert.equal(monthsEmployedInYear("2026-03-15", 2026, "2026-10-19"), 8);
  assert.equal(monthsEmployedInYear("2025-06-01", 2025, "2026-10-19"), 7);
  assert.equal(monthsEmployedInYear("2026-11-01", 2026, "2026-10-19"), 0);
  assert.equal(monthsEmployedInYear(null, 2026, "2026-10-19"), 10);
});

test("annualEntitlementForYear: rate times months, inactive is zero", () => {
  assert.equal(
    annualEntitlementForYear(employee({ startDate: "2026-03-01", monthlyLeaveDays: 1.5 }), 2026, "2026-10-19"),
    12,
  );
  assert.equal(
    annualEntitlementForYear(employee({ status: "Inactive" }), 2026, "2026-10-19"),
    0,
  );
});

test("leaveKindFromType: annual, sick, unpaid, and unknown", () => {
  assert.equal(leaveKindFromType(annual), "annual");
  assert.equal(leaveKindFromType(sick), "sick");
  assert.equal(leaveKindFromType(unpaid), "unpaid");
  assert.equal(leaveKindFromType({ name: "Marriage" }), "other");
  assert.equal(leaveKindFromType(null), "other");
});

test("utilizationPercent: happy path and no entitlement", () => {
  assert.equal(utilizationPercent(9, 18), 50);
  assert.equal(utilizationPercent(4, 0), 0);
});

test("peopleOnLeave and peopleUpcoming: only approved in the window", () => {
  const today = "2026-10-19";
  const rows = [
    request({ id: "now", name: "Ali", startDate: "2026-10-18", endDate: "2026-10-20" }),
    request({ id: "soon", name: "Bilel", startDate: "2026-10-25", endDate: "2026-10-27" }),
    request({ id: "later", name: "Cyrine", startDate: "2026-11-20", endDate: "2026-11-22" }),
    request({ id: "pending", status: "Pending", name: "Dina", startDate: "2026-10-19", endDate: "2026-10-19" }),
  ];
  assert.deepEqual(peopleOnLeave(rows, today).map((row) => row.name), ["Ali"]);
  assert.deepEqual(peopleUpcoming(rows, today).map((row) => row.name), ["Bilel"]);
});

test("authorizationTotals: approved hours in the year become days at 8 h", () => {
  const totals = authorizationTotals(
    [
      { date: "2026-10-01", status: "Approved", durationMinutes: 240 },
      { date: "2026-10-02", status: "Approved", durationMinutes: 240 },
      { date: "2026-10-03", status: "Pending", durationMinutes: 480 },
      { date: "2025-10-01", status: "Approved", durationMinutes: 480 },
    ],
    2026,
  );
  assert.equal(totals.hours, 8);
  assert.equal(totals.days, 1);
  assert.equal(totals.count, 2);
});

test("analyticsYearOptions: current year plus earlier data years", () => {
  assert.deepEqual(analyticsYearOptions(["2025-12-01", "2026-01-02", "1999-01-01"], 2026), [2026, 2025]);
});

test("groupDaysByKind and groupDaysByDepartment", () => {
  const rows = [
    request({ leaveTypeId: annual.id, startDate: "2026-10-01", endDate: "2026-10-02", department: "Studio" }),
    request({ leaveTypeId: sick.id, type: "Sick leave", startDate: "2026-10-03", endDate: "2026-10-03", department: "Sales" }),
  ];
  const kinds = groupDaysByKind(rows, [annual, sick, unpaid], "2026-01-01", "2026-12-31");
  assert.equal(kinds.find((row) => row.kind === "annual")?.days, 2);
  assert.equal(kinds.find((row) => row.kind === "sick")?.days, 1);
  const departments = groupDaysByDepartment(rows, [], "2026-01-01", "2026-12-31");
  assert.equal(departments[0].days, 2);
});

test("buildLeaveAnalytics: annual utilization ignores sick leave", () => {
  const snapshot = buildLeaveAnalytics({
    year: 2026,
    today: "2026-10-19",
    leaveTypes: [annual, sick],
    employees: [employee({ id: "e1", monthlyLeaveDays: 1.5, startDate: "2026-01-01" })],
    requests: [
      request({
        id: "ann",
        leaveTypeId: annual.id,
        startDate: "2026-10-01",
        endDate: "2026-10-02",
      }),
      request({
        id: "sic",
        leaveTypeId: sick.id,
        type: "Sick leave",
        startDate: "2026-10-03",
        endDate: "2026-10-05",
      }),
    ],
    authorizations: [{ date: "2026-10-10", status: "Approved", durationMinutes: 480 }],
  });
  assert.equal(snapshot.annualDaysTaken, 2);
  assert.equal(snapshot.daysTaken, 5);
  assert.equal(snapshot.entitlement, 15);
  assert.equal(snapshot.utilization, 13);
  assert.equal(snapshot.authorizationDays, 1);
  assert.equal(snapshot.monthDays[9], 5);
});

test("addIsoDays: moves forward on the calendar", () => {
  assert.equal(addIsoDays("2026-10-19", 14), "2026-11-02");
});
