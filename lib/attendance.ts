export const ATTENDANCE_TIMEZONE = "Africa/Tunis";
export const ATTENDANCE_MAX_RANGE_DAYS = 92;

export type AttendancePunchType = "entry" | "exit";
export type AttendanceState = "absent" | "present" | "locked" | "incomplete";
export type AttendanceErrorCode =
  | "STALE_STATE"
  | "MAX_SESSIONS"
  | "INCOMPLETE_DAY"
  | "INVALID_SEQUENCE"
  | "FORBIDDEN"
  | "UNAUTHENTICATED"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "SERVER_ERROR";

export type AttendanceTimelineItem = {
  id: string;
  type: AttendancePunchType;
  occurredAt: string;
  sequenceNo: number;
  source: "employee" | "correction" | "admin";
};

export type AttendanceSession = {
  entryId: string;
  exitId: string | null;
  entryAt: string;
  exitAt: string | null;
  durationMinutes: number | null;
};

export type ScheduleSegment = {
  id?: string;
  isoWeekday?: number;
  kind: "work" | "break";
  startTime: string;
  endTime: string;
  position: number;
};

export type ScheduleAssignment = {
  id?: string;
  employeeId: string;
  scheduleId?: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type WorkSchedule = {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  segments: ScheduleSegment[];
  assignments?: ScheduleAssignment[];
};

export type AttendanceSettings = {
  timezone: string;
  graceMinutes: number;
  maxSessions: number;
};

export type MatchedAuthorization = {
  id: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  reason: string;
};

export type AttendanceDaySummary = {
  employeeId: string;
  workDate: string;
  serverTime: string;
  timezone: string;
  state: AttendanceState;
  nextAction: AttendancePunchType | null;
  blockReason: string | null;
  latestPunchId: string | null;
  firstEntryAt: string | null;
  lastExitAt: string | null;
  openSince: string | null;
  workedMinutes: number;
  openMinutes: number;
  completedSessions: number;
  sessionsStarted: number;
  remainingSessions: number;
  isWorkingDay: boolean;
  isUnscheduledWork: boolean;
  hasInvalidSequence: boolean;
  timeline: AttendanceTimelineItem[];
  sessions: AttendanceSession[];
  scheduleId: string | null;
  scheduleSegments: ScheduleSegment[];
  authorizations: MatchedAuthorization[];
};

export type AttendanceReportItem = AttendanceDaySummary & {
  employeeName: string;
  departmentId: string | null;
  departmentName: string;
};

export type CorrectionOperation = "add" | "change" | "void";
export type CorrectionStatus = "pending" | "approved" | "rejected";

export type AttendanceCorrectionRequest = {
  id: string;
  requesterId: string;
  employeeId: string;
  workDate: string;
  operation: CorrectionOperation;
  targetPunchId: string | null;
  proposedType: AttendancePunchType | null;
  proposedOccurredAt: string | null;
  reason: string;
  status: CorrectionStatus;
  reviewerId: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type AttendanceApiError = {
  error: {
    code: AttendanceErrorCode;
    message: string;
  };
};

export function formatAttendanceDuration(minutes: number) {
  const safe = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function dateRangeDays(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}
