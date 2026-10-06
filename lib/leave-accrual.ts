// Vacation earned from the time clock, with the same quarter-hour rules as
// payroll (creditDay). Pure, so it runs under `npm test`.
//
// For each month since the hire date:
//   earned days = credited hours ÷ scheduled hours of the month × the month's rate
// - credited hours: punched time inside the schedule, entries moved up and exits
//   moved down to the quarter; overtime earns nothing;
// - public holidays and approved paid leave are left out of both sides, so they
//   neither earn nor cost vacation;
// - approved authorization time that was not worked is deducted from the
//   balance (8 h = 1 day), as before.

import { creditDay, round3, type PunchSession, type TimeWindow } from "./payroll-calc";

export type CreditWindowDay = {
  date: string;
  scheduledMinutes: number;
  segments: TimeWindow[];
  sessions: PunchSession[];
  authorizations: TimeWindow[];
};

export type RateChange = { effectiveMonth: string; monthlyDays: number };

export type AccrualMonth = {
  month: string;
  scheduledHours: number;
  creditedHours: number;
  uncoveredAuthorizationHours: number;
  rate: number;
  earnedDays: number;
  /** Vacation earned by one credited hour this month. */
  hourValueDays: number;
};

export type Accrual = {
  months: AccrualMonth[];
  earnedDays: number;
  uncoveredAuthorizationHours: number;
};

/** Hours of authorization worth one vacation day. */
export const AUTHORIZATION_DAY_HOURS = 8;

/** Rate in force for "YYYY-MM": the latest change effective on or before it, else `current`. */
export function rateForMonth(changes: RateChange[], month: string, current: number) {
  const first = `${month}-01`;
  const applicable = changes
    .filter((change) => change.effectiveMonth <= first)
    .sort((a, b) => b.effectiveMonth.localeCompare(a.effectiveMonth))[0];
  return applicable?.monthlyDays ?? current;
}

const roundDays = (value: number) => Math.round(value * 10000) / 10000;

export function accrueLeave(
  days: CreditWindowDay[],
  options: {
    employedFrom: string | null;
    /** Today, "YYYY-MM-DD": later days are not earned yet. */
    today: string;
    /** Current time "HH:MM", closes a session still open today. */
    now: string | null;
    holidays: ReadonlySet<string>;
    /** Dates of approved paid leave. */
    paidLeave: ReadonlySet<string>;
    rateFor: (month: string) => number;
  },
): Accrual {
  type Totals = { scheduled: number; credited: number; uncovered: number };
  const byMonth = new Map<string, Totals>();

  for (const day of days) {
    if (day.scheduledMinutes <= 0) continue;
    if (options.holidays.has(day.date) || options.paidLeave.has(day.date)) continue;
    const month = day.date.slice(0, 7);
    if (options.employedFrom && month < options.employedFrom.slice(0, 7)) continue;
    const totals = byMonth.get(month) ?? { scheduled: 0, credited: 0, uncovered: 0 };
    // The whole month's schedule is the reference, so the rate is reached at month end.
    totals.scheduled += day.scheduledMinutes;
    byMonth.set(month, totals);

    const employed = !options.employedFrom || day.date >= options.employedFrom;
    if (!employed || day.date > options.today) continue;
    const now = day.date === options.today ? options.now : null;
    const worked = creditDay(day.segments, day.sessions, [], now).creditedMinutes;
    const withAuthorizations = creditDay(day.segments, day.sessions, day.authorizations, now).creditedMinutes;
    totals.credited += Math.min(day.scheduledMinutes, worked);
    totals.uncovered += Math.max(0, withAuthorizations - worked);
  }

  const months = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, totals]): AccrualMonth => {
      const rate = options.rateFor(month);
      const scheduledHours = totals.scheduled / 60;
      const creditedHours = totals.credited / 60;
      const earned = scheduledHours > 0 ? Math.min(rate, (creditedHours / scheduledHours) * rate) : 0;
      return {
        month,
        scheduledHours: round3(scheduledHours),
        creditedHours: round3(creditedHours),
        uncoveredAuthorizationHours: round3(totals.uncovered / 60),
        rate,
        earnedDays: roundDays(earned),
        hourValueDays: scheduledHours > 0 ? roundDays(rate / scheduledHours) : 0,
      };
    });

  return {
    months,
    earnedDays: roundDays(months.reduce((total, month) => total + month.earnedDays, 0)),
    uncoveredAuthorizationHours: round3(
      months.reduce((total, month) => total + month.uncoveredAuthorizationHours, 0),
    ),
  };
}

/** Balance shown everywhere: ledger (opening − approved) + earned − unworked authorization time. */
export function vacationBalance(ledgerDays: number, accrual: Accrual) {
  return roundDays(
    ledgerDays + accrual.earnedDays - accrual.uncoveredAuthorizationHours / AUTHORIZATION_DAY_HOURS,
  );
}
