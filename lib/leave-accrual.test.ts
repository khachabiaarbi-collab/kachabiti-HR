import { test } from "node:test";
import assert from "node:assert/strict";
import { accrueLeave, rateForMonth, vacationBalance, type CreditWindowDay } from "./leave-accrual";

const week = [
  { start: "08:00", end: "12:00" },
  { start: "13:00", end: "17:00" },
];
const saturday = [{ start: "08:00", end: "13:30" }];

/** A month on the default schedule; `worked` maps a date to its sessions. */
function month(
  ym: string,
  worked: Record<string, { in: string; out: string | null }[]> = {},
  authorizations: Record<string, { start: string; end: string }[]> = {},
): CreditWindowDay[] {
  const [year, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, index) => {
    const date = `${ym}-${String(index + 1).padStart(2, "0")}`;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const segments = weekday === 0 ? [] : weekday === 6 ? saturday : week;
    const scheduledMinutes = weekday === 0 ? 0 : weekday === 6 ? 330 : 480;
    return { date, scheduledMinutes, segments, sessions: worked[date] ?? [], authorizations: authorizations[date] ?? [] };
  });
}

const fullDay = [
  { in: "07:58", out: "12:00" },
  { in: "13:00", out: "17:10" },
];

/** Every scheduled day of the month worked in full (quarter rules applied). */
function workedEveryDay(ym: string) {
  const sessions: Record<string, { in: string; out: string | null }[]> = {};
  for (const day of month(ym)) {
    if (day.scheduledMinutes === 480) sessions[day.date] = fullDay;
    if (day.scheduledMinutes === 330) sessions[day.date] = [{ in: "08:00", out: "13:30" }];
  }
  return sessions;
}

const base = {
  employedFrom: "2026-01-01",
  now: null,
  holidays: new Set<string>(),
  paidLeave: new Set<string>(),
  rateFor: () => 1.5,
};

test("a full month worked earns the whole rate (1.5 days)", () => {
  const accrual = accrueLeave(month("2026-09", workedEveryDay("2026-09")), { ...base, today: "2026-09-30" });
  assert.equal(accrual.months[0].scheduledHours, 22 * 8 + 4 * 5.5);
  assert.equal(accrual.months[0].creditedHours, 22 * 8 + 4 * 5.5);
  assert.equal(accrual.earnedDays, 1.5);
});

test("vacation grows during the month: each credited hour adds rate ÷ scheduled hours", () => {
  // October 2026: 22 weekdays × 8 h + 5 Saturdays × 5.5 h = 203.5 h.
  const accrual = accrueLeave(month("2026-10", { "2026-10-01": fullDay }), { ...base, today: "2026-10-06" });
  const october = accrual.months[0];
  assert.equal(october.scheduledHours, 203.5);
  assert.equal(october.creditedHours, 8);
  assert.equal(october.hourValueDays, Math.round((1.5 / 203.5) * 10000) / 10000);
  assert.equal(accrual.earnedDays, Math.round((8 / 203.5) * 1.5 * 10000) / 10000);
});

test("lateness and overtime follow the quarter rules (late 08:10 loses 15 min, overtime earns nothing)", () => {
  const accrual = accrueLeave(
    month("2026-10", { "2026-10-01": [{ in: "08:10", out: "12:00" }, { in: "13:00", out: "19:00" }] }),
    { ...base, today: "2026-10-06" },
  );
  assert.equal(accrual.months[0].creditedHours, 7.75);
});

test("a hire on the 15th starts at 0 and earns from that day only", () => {
  const sessions = workedEveryDay("2026-09");
  const accrual = accrueLeave(month("2026-09", sessions), {
    ...base,
    employedFrom: "2026-09-15",
    today: "2026-09-30",
  });
  // 12 weekdays × 8 h + 2 Saturdays × 5.5 h from Tuesday the 15th, out of 198 h.
  assert.equal(accrual.months[0].creditedHours, 12 * 8 + 2 * 5.5);
  assert.equal(accrual.earnedDays, Math.round(((12 * 8 + 11) / 198) * 1.5 * 10000) / 10000);
});

test("a rate change applies from its month on, past months keep their rate", () => {
  const changes = [
    { effectiveMonth: "2000-01-01", monthlyDays: 1.5 },
    { effectiveMonth: "2026-10-01", monthlyDays: 2 },
  ];
  assert.equal(rateForMonth(changes, "2026-09", 2), 1.5);
  assert.equal(rateForMonth(changes, "2026-10", 2), 2);
  assert.equal(rateForMonth([], "2026-09", 1.5), 1.5);
  const days = [...month("2026-09", workedEveryDay("2026-09")), ...month("2026-10", workedEveryDay("2026-10"))];
  const accrual = accrueLeave(days, {
    ...base,
    today: "2026-10-31",
    rateFor: (ym) => rateForMonth(changes, ym, 2),
  });
  assert.deepEqual(accrual.months.map((item) => item.earnedDays), [1.5, 2]);
  assert.equal(accrual.earnedDays, 3.5);
});

test("public holidays and paid leave neither earn nor cost vacation", () => {
  const sessions = workedEveryDay("2026-09");
  delete sessions["2026-09-01"];
  delete sessions["2026-09-02"];
  const accrual = accrueLeave(month("2026-09", sessions), {
    ...base,
    today: "2026-09-30",
    holidays: new Set(["2026-09-01"]),
    paidLeave: new Set(["2026-09-02"]),
  });
  assert.equal(accrual.earnedDays, 1.5);
});

test("an approved authorization not worked is deducted from the balance (8 h = 1 day)", () => {
  const sessions = workedEveryDay("2026-09");
  sessions["2026-09-01"] = [{ in: "10:00", out: "12:00" }, { in: "13:00", out: "17:00" }];
  const accrual = accrueLeave(month("2026-09", sessions, { "2026-09-01": [{ start: "08:00", end: "10:00" }] }), {
    ...base,
    today: "2026-09-30",
  });
  assert.equal(accrual.uncoveredAuthorizationHours, 2);
  // Opening balance 5 days entered by the admin.
  assert.equal(vacationBalance(5, accrual), Math.round((5 + accrual.earnedDays - 2 / 8) * 10000) / 10000);
});

test("a new employee with no opening balance starts at 0", () => {
  const accrual = accrueLeave(month("2026-10"), { ...base, employedFrom: "2026-10-06", today: "2026-10-06" });
  assert.equal(vacationBalance(0, accrual), 0);
});
