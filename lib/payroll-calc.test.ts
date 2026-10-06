// Run with `npm test`. Expected values were computed independently (decimal
// arithmetic, half-up rounding to millimes) from the method in payroll-calc.ts
// and the 2026 starting rates. Add the accountant's reference payslips here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountInFrenchWords,
  calculatePayslip,
  progressiveTax,
  creditDay,
  round3,
  summarizeAttendance,
  workingDaysInRange,
  type PayContract,
  type PayrollRates,
  type PayVariables,
} from "./payroll-calc";

const rates2026: PayrollRates = {
  cnssEmployeeRate: 0.0918,
  cnssEmployerRate: 0.1657,
  workAccidentRate: 0,
  cssRate: 0.005,
  irppBrackets: [
    { upTo: 5000, rate: 0 },
    { upTo: 10000, rate: 0.15 },
    { upTo: 20000, rate: 0.25 },
    { upTo: 30000, rate: 0.3 },
    { upTo: 40000, rate: 0.33 },
    { upTo: 50000, rate: 0.36 },
    { upTo: 70000, rate: 0.38 },
    { upTo: null, rate: 0.4 },
  ],
  professionalExpensesRate: 0.1,
  professionalExpensesCap: 2000,
  headOfFamilyDeduction: 300,
  childDeduction: 100,
  maxChildren: 4,
  overtimeRate: 1.25,
};

const monthly = (baseSalary: number, extra: Partial<PayContract> = {}): PayContract => ({
  payBasis: "monthly",
  baseSalary,
  hourlyRate: null,
  weeklyHours: 48,
  headOfFamily: false,
  dependentChildren: 0,
  ...extra,
});

const noVariables: PayVariables = { workedHours: 0, unpaidDays: 0, outsideContractDays: 0, absentDays: 0, absenceHours: 0, overtimeHours: 0 };

test("1500 TND, single, no extras", () => {
  const result = calculatePayslip(monthly(1500), rates2026, noVariables);
  assert.equal(result.gross, 1500);
  assert.equal(result.cnssEmployee, 137.7);
  assert.equal(result.taxableIncome, 1362.3);
  assert.equal(result.professionalExpenses, 1634.76);
  assert.equal(result.annualNetTaxable, 14712.84);
  assert.equal(result.irpp, 160.684);
  assert.equal(result.css, 6.13);
  assert.equal(result.net, 1195.486);
  assert.equal(result.employerCnss, 248.55);
  assert.equal(result.employerCost, 1748.55);
});

test("3000 TND, head of family with 2 children, expenses capped", () => {
  const result = calculatePayslip(
    monthly(3000, { headOfFamily: true, dependentChildren: 2 }),
    rates2026,
    noVariables,
  );
  assert.equal(result.cnssEmployee, 275.4);
  assert.equal(result.professionalExpenses, 2000);
  assert.equal(result.familyDeductions, 500);
  assert.equal(result.annualNetTaxable, 30195.2);
  assert.equal(result.irpp, 526.201);
  assert.equal(result.css, 12.581);
  assert.equal(result.net, 2185.818);
});

test("low salary pays no IRPP and no CSS", () => {
  const result = calculatePayslip(monthly(500), rates2026, noVariables);
  assert.equal(result.irpp, 0);
  assert.equal(result.css, 0);
  assert.equal(result.net, 454.1);
  assert.ok(!result.lines.some((line) => line.code === "css"));
});

test("unpaid day, overtime, bonus and advance", () => {
  const result = calculatePayslip(
    monthly(1850),
    rates2026,
    { workedHours: 0, unpaidDays: 1, outsideContractDays: 0, absentDays: 0, absenceHours: 0, overtimeHours: 10 },
    [
      { code: "transport", label: "Prime de transport", kind: "earning", amount: 80, subjectToCnss: true, taxable: true },
      { code: "advance", label: "Avance sur salaire", kind: "deduction", amount: 200, subjectToCnss: false, taxable: false },
    ],
  );
  const byCode = Object.fromEntries(result.lines.map((line) => [line.code, line.amount]));
  assert.equal(byCode.unpaid, -71.154);
  assert.equal(byCode.overtime, 111.178);
  assert.equal(result.gross, 1970.024);
  assert.equal(result.cnssEmployee, 180.848);
  assert.equal(result.irpp, 259.794);
  assert.equal(result.css, 8.113);
  assert.equal(result.otherDeductions, 200);
  assert.equal(result.net, 1321.269);
});

test("high salary reaches the 40% bracket", () => {
  const result = calculatePayslip(monthly(8000), rates2026, noVariables);
  assert.equal(result.irpp, 2235.407);
  assert.equal(result.css, 35.495);
  assert.equal(result.net, 4994.698);
});

test("non-taxable bonus adds to net but not to IRPP", () => {
  const plain = calculatePayslip(monthly(1500), rates2026, noVariables);
  const withBonus = calculatePayslip(monthly(1500), rates2026, noVariables, [
    { code: "gift", label: "Prime exceptionnelle", kind: "earning", amount: 100, subjectToCnss: false, taxable: false },
  ]);
  assert.equal(withBonus.irpp, plain.irpp);
  assert.equal(withBonus.cnssEmployee, plain.cnssEmployee);
  assert.equal(withBonus.net, round3(plain.net + 100));
});

test("absences never push the base below zero", () => {
  const result = calculatePayslip(
    monthly(1000),
    rates2026,
    { workedHours: 0, unpaidDays: 40, outsideContractDays: 5, absentDays: 3, absenceHours: 50, overtimeHours: 0 },
  );
  assert.equal(result.gross, 0);
  assert.equal(result.net, 0);
});

test("hire on the 15th removes the days before it", () => {
  // 48h week: 1500 / 208 h × 8 h = 57.692 per day; 12 working days before hire.
  const result = calculatePayslip(monthly(1500), rates2026, { ...noVariables, outsideContractDays: 12 });
  const outside = result.lines.find((line) => line.code === "outside");
  assert.equal(outside?.amount, -692.308);
  assert.equal(result.gross, 807.692);
});

test("hourly contract pays worked hours", () => {
  const result = calculatePayslip(
    { ...monthly(0), payBasis: "hourly", hourlyRate: 7.5 },
    rates2026,
    { workedHours: 160, unpaidDays: 3, outsideContractDays: 2, absentDays: 4, absenceHours: 0, overtimeHours: 0 },
  );
  assert.equal(result.gross, 1200);
  assert.ok(!result.lines.some((line) => line.code === "unpaid"));
});

test("progressive tax", () => {
  assert.equal(progressiveTax(5000, rates2026.irppBrackets), 0);
  assert.equal(round3(progressiveTax(10000, rates2026.irppBrackets)), 750);
  assert.equal(round3(progressiveTax(80000, rates2026.irppBrackets)), 24750);
});

test("working days skip Sundays (and Saturdays on a 5-day week) and holidays", () => {
  // September 2026: 1st is a Tuesday.
  assert.equal(workingDaysInRange("2026-09-01", "2026-09-30", "2026-09-01", "2026-09-30", true), 26);
  assert.equal(workingDaysInRange("2026-09-01", "2026-09-30", "2026-09-01", "2026-09-30", false), 22);
  assert.equal(workingDaysInRange("2026-08-28", "2026-09-02", "2026-09-01", "2026-09-30", true), 2);
  assert.equal(
    workingDaysInRange("2026-09-01", "2026-09-03", "2026-09-01", "2026-09-30", true, new Set(["2026-09-02"])),
    2,
  );
});

test("amount in French words", () => {
  assert.equal(amountInFrenchWords(1195.486), "mille cent quatre-vingt-quinze dinars et quatre cent quatre-vingt-six millimes");
  assert.equal(amountInFrenchWords(2000), "deux mille dinars");
  assert.equal(amountInFrenchWords(71.1), "soixante et onze dinars et cent millimes");
  assert.equal(amountInFrenchWords(200000), "deux cent mille dinars");
  assert.equal(amountInFrenchWords(1), "un dinar");
});

test("SIVP pays no CNSS, IRPP, CSS or employer charges", () => {
  const result = calculatePayslip({ ...monthly(800), contractType: "sivp" }, rates2026, noVariables);
  assert.equal(result.gross, 800);
  assert.equal(result.cnssEmployee, 0);
  assert.equal(result.irpp, 0);
  assert.equal(result.css, 0);
  assert.equal(result.employerCnss, 0);
  assert.equal(result.net, 800);
  assert.equal(result.employerCost, 800);
  assert.deepEqual(
    result.lines.map((line) => line.code),
    ["base"],
  );
});

test("a CDI at the same salary still pays contributions", () => {
  const result = calculatePayslip({ ...monthly(800), contractType: "cdi" }, rates2026, noVariables);
  assert.equal(result.cnssEmployee, 73.44);
});

test("absent days are deducted like unpaid days", () => {
  const result = calculatePayslip(monthly(1500), rates2026, { ...noVariables, absentDays: 2 });
  const line = result.lines.find((item) => item.code === "absent_days");
  assert.equal(line?.amount, -115.385);
  assert.equal(result.gross, 1384.615);
});

test("payslips saved before absentDays existed still calculate", () => {
  const { absentDays: _omit, ...old } = noVariables;
  const result = calculatePayslip(monthly(1500), rates2026, old as typeof noVariables);
  assert.equal(result.net, 1195.486);
});

const day = (date: string, scheduled: number, worked: number, authorized = 0) => ({
  date,
  scheduledMinutes: scheduled,
  workedMinutes: worked,
  authorizedMinutes: authorized,
});

test("attendance: absent days, short days, leave, holidays, contract window", () => {
  const days = [
    day("2026-09-01", 480, 540), // full day (lunch inside the session)
    day("2026-09-02", 480, 240), // half day: 4h missing
    day("2026-09-03", 480, 0, 60), // authorization only: 7h missing
    day("2026-09-04", 480, 0), // absent
    day("2026-09-05", 300, 0), // Saturday: unpaid leave
    day("2026-09-06", 0, 0), // Sunday: not scheduled
    day("2026-09-07", 480, 0), // paid leave
    day("2026-09-08", 480, 0), // public holiday
    day("2026-09-09", 480, 470), // 10 min short, within grace
    day("2026-09-10", 480, 0), // after contract end
    day("2026-09-11", 480, 480), // after the counted-until date: ignored
  ];
  const summary = summarizeAttendance(days, {
    countedUntil: "2026-09-10",
    employedFrom: null,
    employedTo: "2026-09-09",
    holidays: new Set(["2026-09-08"]),
    leave: new Map([
      ["2026-09-05", true],
      ["2026-09-07", false],
    ]),
    graceMinutes: 15,
  });
  assert.equal(summary.absentDays, 1);
  assert.equal(summary.missingHours, 11);
  assert.equal(summary.unpaidDays, 1);
  assert.equal(summary.paidLeaveDays, 1);
  assert.equal(summary.holidayDays, 1);
  assert.equal(summary.outsideContractDays, 1);
  assert.equal(summary.workedDays, 3); // the 3rd has an authorization but no punch
  assert.equal(summary.workedHours, round3((540 + 240 + 470) / 60));
});

test("attendance: a hire on the 3rd makes the 1st and 2nd outside the contract", () => {
  const summary = summarizeAttendance(
    [day("2026-10-01", 480, 0), day("2026-10-02", 480, 0), day("2026-10-03", 300, 300)],
    {
      countedUntil: "2026-10-31",
      employedFrom: "2026-10-03",
      employedTo: null,
      holidays: new Set(),
      leave: new Map(),
      graceMinutes: 5,
    },
  );
  assert.equal(summary.outsideContractDays, 2);
  assert.equal(summary.absentDays, 0);
  assert.equal(summary.workedDays, 1);
});

const octoberSchedule = (worked: Record<string, number>) =>
  Array.from({ length: 31 }, (_, index) => {
    const date = `2026-10-${String(index + 1).padStart(2, "0")}`;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const scheduled = weekday === 0 ? 0 : weekday === 6 ? 300 : 480;
    return day(date, scheduled, worked[date] ?? 0);
  });

test("month in progress: Takwa (SIVP, from 3 Oct) is paid only the 9 hours worked so far", () => {
  const summary = summarizeAttendance(octoberSchedule({ "2026-10-03": 300, "2026-10-05": 240 }), {
    countedUntil: "2026-10-05",
    employedFrom: "2026-10-03",
    employedTo: "2027-07-28",
    holidays: new Set(),
    leave: new Map(),
    graceMinutes: 5,
    today: "2026-10-05",
  });
  assert.equal(summary.outsideContractDays, 2); // 1st and 2nd
  assert.equal(summary.absentDays, 0); // today is not over, the rest is in the future
  assert.equal(summary.earnedHours, 9);

  const result = calculatePayslip(
    { ...monthly(800), contractType: "sivp" },
    rates2026,
    {
      ...noVariables,
      outsideContractDays: summary.outsideContractDays,
      absentDays: summary.absentDays,
      absenceHours: summary.missingHours,
      earnedHours: summary.earnedHours,
    },
  );
  assert.equal(result.gross, 34.615); // 800 / 208 h × 9 h
  assert.equal(result.cnssEmployee, 0);
  assert.equal(result.irpp, 0);
  assert.equal(result.net, 34.615);
  assert.ok(result.lines.some((line) => line.code === "remaining"));
});

test("month in progress: a past day without punch is absent, future days are not", () => {
  const summary = summarizeAttendance(
    octoberSchedule({ "2026-10-01": 480, "2026-10-05": 480 }),
    {
      countedUntil: "2026-10-06",
      employedFrom: null,
      employedTo: null,
      holidays: new Set(),
      leave: new Map(),
      graceMinutes: 5,
      today: "2026-10-06",
    },
  );
  // 2nd (Fri) and 3rd (Sat) absent; 6th is today with nothing yet; 7th onwards future.
  assert.equal(summary.absentDays, 2);
  assert.equal(summary.earnedHours, 16);
  const result = calculatePayslip(monthly(1500), rates2026, {
    ...noVariables,
    absentDays: summary.absentDays,
    earnedHours: summary.earnedHours,
  });
  assert.equal(result.gross, round3((1500 / 208) * 16));
});

test("a finished month ignores earned hours", () => {
  const result = calculatePayslip(monthly(1500), rates2026, { ...noVariables, earnedHours: null });
  assert.equal(result.gross, 1500);
});

// Quarter-hour discipline: the user's own examples on an 08:00–09:00 window.
const hour = [{ start: "08:00", end: "09:00" }];
const credit = (entry: string, exit: string | null, segments = hour, auth: { start: string; end: string }[] = []) =>
  creditDay(segments, [{ in: entry, out: exit }], auth).creditedMinutes / 60;

test("discipline: 07:55 → 09:00 counts 1 h", () => assert.equal(credit("07:55", "09:00"), 1));
test("discipline: 07:55 → 09:15 counts 1 h", () => assert.equal(credit("07:55", "09:15"), 1));
test("discipline: 08:01 → 09:00 counts 0.75 h", () => assert.equal(credit("08:01", "09:00"), 0.75));
test("discipline: 08:01 → 09:15 counts 0.75 h", () => assert.equal(credit("08:01", "09:15"), 0.75));
test("discipline: 08:10 → counts from 08:15", () => assert.equal(credit("08:10", "09:00"), 0.75));
test("discipline: 08:00 → 08:50 counts 0.75 h (exit to 08:45)", () => assert.equal(credit("08:00", "08:50"), 0.75));
test("discipline: 08:16 → counts from 08:30", () => assert.equal(credit("08:16", "09:00"), 0.5));

const weekday = [
  { start: "08:00", end: "12:00" },
  { start: "13:00", end: "17:00" },
];

test("discipline: a full day with one session over the break counts 8 h, nothing after 17:00", () => {
  const day = creditDay(weekday, [{ in: "07:50", out: "17:30" }]);
  assert.equal(day.creditedMinutes, 480);
  assert.equal(day.overtimeMinutes, 0); // 30 min extra is under one hour
  assert.equal(day.lateCount, 0);
});

test("discipline: back from lunch at 13:05 counts from 13:15", () => {
  const day = creditDay(weekday, [
    { in: "08:00", out: "12:00" },
    { in: "13:05", out: "17:05" },
  ]);
  assert.equal(day.creditedMinutes, 465);
  assert.equal(day.lateCount, 1);
});

test("discipline: overtime when the 8 h are done and he leaves at 18:00", () => {
  const day = creditDay(weekday, [
    { in: "08:00", out: "12:00" },
    { in: "13:00", out: "18:00" },
  ]);
  assert.equal(day.creditedMinutes, 480);
  assert.equal(day.overtimeMinutes, 60);
});

test("discipline: no overtime when the day was not complete", () => {
  const day = creditDay(weekday, [
    { in: "08:20", out: "12:00" },
    { in: "13:00", out: "18:30" },
  ]);
  assert.equal(day.creditedMinutes, 450);
  assert.equal(day.overtimeMinutes, 0);
});

test("discipline: authorization 08:00–09:00 and arrival at 09:00 loses nothing", () => {
  assert.equal(
    creditDay(weekday, [{ in: "09:00", out: "17:00" }], [{ start: "08:00", end: "09:00" }]).creditedMinutes,
    480,
  );
});

test("discipline: authorization until 09:00 and arrival at 09:10 counts from 09:15", () => {
  assert.equal(
    creditDay(weekday, [{ in: "09:10", out: "17:00" }], [{ start: "08:00", end: "09:00" }]).creditedMinutes,
    465,
  );
});

test("discipline: Saturday 08:00–13:30", () => {
  const saturday = [{ start: "08:00", end: "13:30" }];
  assert.equal(creditDay(saturday, [{ in: "07:58", out: "13:40" }]).creditedMinutes, 330);
  assert.equal(creditDay(saturday, [{ in: "08:05", out: "13:20" }]).creditedMinutes, 300);
});

test("discipline: a session still open today closes at now; other days it is ignored", () => {
  assert.equal(creditDay(weekday, [{ in: "08:00", out: null }], [], "10:40").creditedMinutes, 150);
  assert.equal(creditDay(weekday, [{ in: "08:00", out: null }]).creditedMinutes, 0);
});

import { summarizeClockMonth } from "./payroll-calc";

const weekdaySegments = [
  { start: "08:00", end: "12:00" },
  { start: "13:00", end: "17:00" },
];
const clockDay = (date: string, sessions: { in: string; out: string | null }[], auth: { start: string; end: string }[] = []) => {
  const weekdayIndex = new Date(`${date}T00:00:00Z`).getUTCDay();
  const segments = weekdayIndex === 0 ? [] : weekdayIndex === 6 ? [{ start: "08:00", end: "13:30" }] : weekdaySegments;
  const scheduledMinutes = segments.reduce((total, s) => {
    const [ah, am] = s.start.split(":").map(Number);
    const [bh, bm] = s.end.split(":").map(Number);
    return total + (bh * 60 + bm) - (ah * 60 + am);
  }, 0);
  return { date, scheduledMinutes, workedMinutes: 0, authorizedMinutes: 0, segments, sessions, authorizations: auth };
};

test("clock month: the five parts add up to the scheduled hours", () => {
  const days = [
    clockDay("2026-09-01", [{ in: "07:55", out: "12:00" }, { in: "13:00", out: "18:10" }]), // 8 h + 1 h overtime (18:10 rounds down to 18:00)
    clockDay("2026-09-02", [{ in: "08:10", out: "12:00" }, { in: "13:00", out: "16:50" }]), // 7.5 h, late + early
    clockDay("2026-09-03", []), // absent
    clockDay("2026-09-04", []), // unpaid leave
    clockDay("2026-09-05", [{ in: "08:00", out: "13:30" }]), // Saturday 5.5 h
    clockDay("2026-09-07", [{ in: "08:00", out: "12:00" }]), // today: morning done, afternoon not yet
    clockDay("2026-09-08", []), // future
  ];
  const month = summarizeClockMonth(days, {
    employedFrom: "2026-09-01",
    employedTo: null,
    holidays: new Set(),
    leave: new Map([["2026-09-04", true]]),
    today: "2026-09-07",
    now: "14:00",
  });
  assert.equal(month.scheduledHours, 8 * 6 + 5.5);
  assert.equal(month.creditedHours, 8 + 7.5 + 5.5 + 4);
  assert.equal(month.absenceHours, 0.5 + 8);
  assert.equal(month.unpaidHours, 8);
  assert.equal(month.notYetHours, 4 + 8);
  assert.equal(month.overtimeHours, 1);
  assert.equal(month.lateCount, 1);
  assert.equal(month.earlyLeaveCount, 1);
  assert.equal(month.absentDays, 1);
  assert.equal(
    round3(month.creditedHours + month.outsideHours + month.unpaidHours + month.absenceHours + month.notYetHours),
    month.scheduledHours,
  );
});

test("clock pay: salary per scheduled hour, deductions and overtime at 125 %", () => {
  // 200 h scheduled, 1 h absence, 1 h overtime, 1000 TND → 5 TND / h.
  const result = calculatePayslip(monthly(1000), rates2026, {
    ...noVariables,
    scheduledHours: 200,
    absenceHours: 1,
    overtimeHours: 1,
  });
  const byCode = Object.fromEntries(result.lines.map((line) => [line.code, line.amount]));
  assert.equal(byCode.base, 1000);
  assert.equal(byCode.absence, -5);
  assert.equal(byCode.overtime, 6.25);
  assert.equal(result.gross, 1001.25);
});

test("clock pay: Takwa (SIVP) paid only her credited hours so far", () => {
  // 203.5 h scheduled in October; she has 9 h credited, 16 h outside her contract, the rest not yet.
  const result = calculatePayslip({ ...monthly(800), contractType: "sivp" }, rates2026, {
    ...noVariables,
    scheduledHours: 203.5,
    outsideHours: 16,
    notYetHours: 203.5 - 16 - 9,
  });
  assert.equal(result.gross, round3((800 / 203.5) * 9));
  assert.equal(result.cnssEmployee, 0);
  assert.equal(result.irpp, 0);
});

test("clock month: an open session today is not an early departure", () => {
  const month = summarizeClockMonth([clockDay("2026-10-06", [{ in: "08:00", out: null }])], {
    employedFrom: null,
    employedTo: null,
    holidays: new Set(),
    leave: new Map(),
    today: "2026-10-06",
    now: "11:00",
  });
  assert.equal(month.creditedHours, 3);
  assert.equal(month.notYetHours, 5);
  assert.equal(month.earlyLeaveCount, 0);
  assert.equal(month.absenceHours, 0);
});
