import { DEFAULT_MONTHLY_LEAVE_DAYS } from "@/lib/map-rows";

const WEEKDAY_MINUTES = 8 * 60;
const SATURDAY_MINUTES = 5 * 60;

export type LeavePunch = {
  employeeId: string;
  workDate: string;
  type: "entry" | "exit";
  occurredAt: string;
  sequenceNo: number;
};

export type LeaveHourMonth = {
  month: string;
  scheduledHours: number;
  punchedHours: number;
  extraHours: number;
  earnedDays: number;
  uncoveredAuthorizationHours: number;
  hourValueDays: number;
};

export type LeaveHourSelf = {
  balanceDays: number;
  monthlyRate: number;
  thisMonth: LeaveHourMonth;
};

export type LeaveHourTeamItem = LeaveHourMonth & {
  employeeId: string;
  employeeName: string;
};

export type DatedAuthorization = {
  date: string;
  durationMinutes: number;
};

export type DatedLeave = {
  startDate: string;
  endDate: string;
};

function parseIso(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function formatIso(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function monthKey(isoDate: string) {
  return isoDate.slice(0, 7);
}

export function monthStart(month: string) {
  return `${month}-01`;
}

export function monthEnd(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

export function scheduledMinutesOnDate(isoDate: string) {
  const day = parseIso(isoDate).getUTCDay();
  if (day === 0) return 0;
  if (day === 6) return SATURDAY_MINUTES;
  return WEEKDAY_MINUTES;
}

export function scheduledMinutesInRange(start: string, end: string) {
  if (!start || !end || start > end) return 0;
  let total = 0;
  const cursor = parseIso(start);
  const last = parseIso(end);
  while (cursor.getTime() <= last.getTime()) {
    total += scheduledMinutesOnDate(formatIso(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return total;
}

function roundHours(minutes: number) {
  return Math.round((minutes / 60) * 100) / 100;
}

function roundDays(value: number) {
  return Math.round(value * 10000) / 10000;
}

export function punchedMinutesByEmployee(punches: LeavePunch[], now: Date) {
  const grouped = new Map<string, LeavePunch[]>();
  for (const punch of punches) {
    const list = grouped.get(punch.employeeId) ?? [];
    list.push(punch);
    grouped.set(punch.employeeId, list);
  }

  const result = new Map<string, Map<string, number>>();
  for (const [employeeId, list] of grouped) {
    const byDay = new Map<string, LeavePunch[]>();
    for (const punch of list) {
      const day = byDay.get(punch.workDate) ?? [];
      day.push(punch);
      byDay.set(punch.workDate, day);
    }
    const minutes = new Map<string, number>();
    for (const [day, dayPunches] of byDay) {
      dayPunches.sort(
        (left, right) =>
          left.sequenceNo - right.sequenceNo ||
          left.occurredAt.localeCompare(right.occurredAt),
      );
      let openAt: string | null = null;
      let totalMs = 0;
      for (const punch of dayPunches) {
        if (punch.type === "entry") {
          openAt = punch.occurredAt;
        } else if (openAt) {
          totalMs += Math.max(0, Date.parse(punch.occurredAt) - Date.parse(openAt));
          openAt = null;
        }
      }
      if (openAt) {
        totalMs += Math.max(0, now.getTime() - Date.parse(openAt));
      }
      minutes.set(day, Math.floor(totalMs / 60000));
    }
    result.set(employeeId, minutes);
  }
  return result;
}

function minutesBetween(
  punchedByDay: Map<string, number>,
  start: string,
  end: string,
) {
  let total = 0;
  for (const [day, minutes] of punchedByDay) {
    if (day >= start && day <= end) total += minutes;
  }
  return total;
}

export function uncoveredAuthorizationMinutes(
  authorizations: DatedAuthorization[],
  punchedByDay: Map<string, number>,
) {
  return authorizations.reduce((total, authorization) => {
    const date = authorization.date.slice(0, 10);
    if (!date) return total;
    const missing = Math.max(
      0,
      scheduledMinutesOnDate(date) - (punchedByDay.get(date) ?? 0),
    );
    return total + Math.min(Math.max(0, authorization.durationMinutes), missing);
  }, 0);
}

export function approvedLeaveDays(ranges: DatedLeave[]) {
  const minutes = ranges.reduce(
    (total, range) =>
      total + scheduledMinutesInRange(range.startDate, range.endDate),
    0,
  );
  return minutes / (8 * 60);
}

export function monthLeaveHours(input: {
  month: string;
  startDate: string | null;
  throughDate: string;
  monthlyRate: number;
  punchedByDay: Map<string, number>;
  authorizations: DatedAuthorization[];
}): LeaveHourMonth {
  const rate =
    input.monthlyRate > 0 ? input.monthlyRate : DEFAULT_MONTHLY_LEAVE_DAYS;
  const start = monthStart(input.month);
  const end = monthEnd(input.month);
  const scheduledMinutes = scheduledMinutesInRange(start, end);
  const windowStart =
    input.startDate && input.startDate > start ? input.startDate : start;
  const windowEnd = input.throughDate < end ? input.throughDate : end;
  const punchedMinutes =
    windowStart <= windowEnd
      ? minutesBetween(input.punchedByDay, windowStart, windowEnd)
      : 0;
  const creditedMinutes = Math.min(punchedMinutes, scheduledMinutes);
  const creditedHours = Math.floor(creditedMinutes / 60);
  const scheduledHours = scheduledMinutes / 60;
  const earnedDays =
    scheduledHours > 0
      ? Math.min(rate, (creditedHours / scheduledHours) * rate)
      : 0;
  const uncoveredMinutes = uncoveredAuthorizationMinutes(
    input.authorizations.filter((authorization) => {
      const date = authorization.date.slice(0, 10);
      return date >= windowStart && date <= windowEnd;
    }),
    input.punchedByDay,
  );
  return {
    month: input.month,
    scheduledHours: roundHours(scheduledMinutes),
    punchedHours: roundHours(punchedMinutes),
    extraHours: roundHours(Math.max(0, punchedMinutes - scheduledMinutes)),
    earnedDays: roundDays(earnedDays),
    uncoveredAuthorizationHours: roundHours(uncoveredMinutes),
    hourValueDays:
      scheduledHours > 0 ? roundDays(rate / scheduledHours) : 0,
  };
}

export function vacationBalanceDays(input: {
  startDate: string | null;
  throughDate: string;
  monthlyRate: number;
  punchedByDay: Map<string, number>;
  authorizations: DatedAuthorization[];
  approvedAnnualLeave: DatedLeave[];
}) {
  if (!input.throughDate) return 0;
  const firstMonth = monthKey(
    input.startDate && input.startDate > "1970-01-01"
      ? input.startDate
      : input.throughDate,
  );
  const lastMonth = monthKey(input.throughDate);
  let earned = 0;
  let month = firstMonth;
  while (month <= lastMonth) {
    earned += monthLeaveHours({
      month,
      startDate: input.startDate,
      throughDate: input.throughDate,
      monthlyRate: input.monthlyRate,
      punchedByDay: input.punchedByDay,
      authorizations: [],
    }).earnedDays;
    const [year, monthNumber] = month.split("-").map(Number);
    const next = new Date(Date.UTC(year, monthNumber, 1));
    month = next.toISOString().slice(0, 7);
  }
  const uncoveredDays =
    uncoveredAuthorizationMinutes(input.authorizations, input.punchedByDay) /
    (8 * 60);
  return roundDays(
    earned - approvedLeaveDays(input.approvedAnnualLeave) - uncoveredDays,
  );
}

export function formatLeaveDayCount(value: number, locale: string) {
  return value.toLocaleString(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}
