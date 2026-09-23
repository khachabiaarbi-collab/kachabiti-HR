import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
  AttendanceCorrectionRequest,
  AttendanceDaySummary,
  AttendanceErrorCode,
  AttendanceReportItem,
  AttendanceSettings,
  WorkSchedule,
} from "@/lib/attendance";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export class AttendanceServerError extends Error {
  constructor(
    public readonly code: AttendanceErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AttendanceAuth = {
  supabase: SupabaseClient;
  userId: string;
  role: string;
  isStaff: boolean;
};

const ERROR_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  STALE_STATE: 409,
  CORRECTION_ALREADY_DECIDED: 409,
  MAX_SESSIONS: 422,
  INCOMPLETE_DAY: 422,
  INVALID_SEQUENCE: 422,
  INVALID_DATE_RANGE: 400,
  INVALID_PAGINATION: 400,
  INVALID_SCHEDULE: 400,
  INVALID_ASSIGNMENTS: 400,
  DEFAULT_SCHEDULE_REQUIRED: 400,
  SCHEDULE_SEGMENT_OVERLAP: 400,
  PROPOSED_TIME_OUTSIDE_WORK_DATE: 400,
  TARGET_PUNCH_NOT_FOUND: 404,
  CORRECTION_NOT_FOUND: 404,
  SCHEDULE_NOT_FOUND: 404,
};

const ERROR_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Please sign in to continue.",
  FORBIDDEN: "You do not have permission to perform this action.",
  STALE_STATE: "Attendance changed in another tab. Refresh and try again.",
  CORRECTION_ALREADY_DECIDED: "This correction request has already been reviewed.",
  MAX_SESSIONS: "The maximum number of sessions has been reached.",
  INCOMPLETE_DAY: "A previous attendance day is incomplete.",
  INVALID_SEQUENCE: "The resulting punch sequence is invalid.",
  INVALID_DATE_RANGE: "Choose a valid date range of at most 93 days.",
  INVALID_PAGINATION: "The requested page is invalid.",
  INVALID_SCHEDULE: "The work schedule is invalid.",
  INVALID_ASSIGNMENTS: "One or more schedule assignments are invalid.",
  DEFAULT_SCHEDULE_REQUIRED: "At least one default schedule is required.",
  SCHEDULE_SEGMENT_OVERLAP: "Schedule segments cannot overlap.",
  PROPOSED_TIME_OUTSIDE_WORK_DATE: "The proposed time must be on the selected work date.",
  TARGET_PUNCH_NOT_FOUND: "The selected punch was not found.",
  CORRECTION_NOT_FOUND: "The correction request was not found.",
  SCHEDULE_NOT_FOUND: "The work schedule was not found.",
};

function databaseCode(error: { message?: string; details?: string } | null) {
  const text = `${error?.message ?? ""} ${error?.details ?? ""}`;
  return Object.keys(ERROR_STATUS).find((code) => text.includes(code));
}

export function throwAttendanceDatabaseError(
  error: { message?: string; details?: string } | null,
): never {
  const code = databaseCode(error);
  if (code) {
    throw new AttendanceServerError(
      code as AttendanceErrorCode,
      ERROR_STATUS[code],
      ERROR_MESSAGES[code],
    );
  }
  throw new AttendanceServerError(
    "SERVER_ERROR",
    500,
    "Attendance could not be updated. Please try again.",
  );
}

export async function requireAttendanceAuth(
  staffOnly = false,
): Promise<AttendanceAuth> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    throw new AttendanceServerError(
      "UNAUTHENTICATED",
      401,
      ERROR_MESSAGES.UNAUTHENTICATED,
    );
  }

  const { data: profile, error } = await supabase
    .from("employees")
    .select("id, role, status")
    .eq("id", user.id)
    .maybeSingle();
  if (error || !profile || profile.status === "inactive") {
    throw new AttendanceServerError("FORBIDDEN", 403, ERROR_MESSAGES.FORBIDDEN);
  }

  const isStaff = profile.role === "admin" || profile.role === "manager";
  if (staffOnly && !isStaff) {
    throw new AttendanceServerError("FORBIDDEN", 403, ERROR_MESSAGES.FORBIDDEN);
  }
  return { supabase, userId: user.id, role: profile.role, isStaff };
}

export async function getTodayAttendance(auth: AttendanceAuth) {
  const { data, error } = await auth.supabase.rpc("attendance_today");
  if (error) throwAttendanceDatabaseError(error);
  return data as AttendanceDaySummary & {
    previousIncomplete: AttendanceDaySummary | null;
  };
}

export async function punchAttendance(
  auth: AttendanceAuth,
  idempotencyKey: string,
  expectedLatestPunchId: string | null,
) {
  const { data, error } = await auth.supabase.rpc("punch_attendance", {
    p_idempotency_key: idempotencyKey,
    p_expected_latest_punch_id: expectedLatestPunchId,
  });
  if (error) throwAttendanceDatabaseError(error);
  return data as AttendanceDaySummary & { punchId: string; replayed: boolean };
}

export async function getAttendanceReport(
  auth: AttendanceAuth,
  filters: {
    from: string;
    to: string;
    employeeId: string | null;
    departmentId: string | null;
    status: string | null;
    page: number;
    pageSize: number;
  },
) {
  const offset = (filters.page - 1) * filters.pageSize;
  const { data, error } = await auth.supabase.rpc("attendance_report", {
    p_from: filters.from,
    p_to: filters.to,
    p_employee_id: filters.employeeId,
    p_department_id: filters.departmentId,
    p_status: filters.status,
    p_limit: filters.pageSize,
    p_offset: offset,
  });
  if (error) throwAttendanceDatabaseError(error);
  const result = data as { items?: AttendanceReportItem[]; total?: number };
  return {
    items: result.items ?? [],
    total: result.total ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

type CorrectionRow = {
  id: string;
  requester_id: string;
  employee_id: string;
  work_date: string;
  operation: AttendanceCorrectionRequest["operation"];
  target_punch_id: string | null;
  proposed_type: AttendanceCorrectionRequest["proposedType"];
  proposed_occurred_at: string | null;
  reason: string;
  status: AttendanceCorrectionRequest["status"];
  reviewer_id: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
};

function mapCorrection(row: CorrectionRow): AttendanceCorrectionRequest {
  return {
    id: row.id,
    requesterId: row.requester_id,
    employeeId: row.employee_id,
    workDate: row.work_date,
    operation: row.operation,
    targetPunchId: row.target_punch_id,
    proposedType: row.proposed_type,
    proposedOccurredAt: row.proposed_occurred_at,
    reason: row.reason,
    status: row.status,
    reviewerId: row.reviewer_id,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export async function listCorrectionRequests(
  auth: AttendanceAuth,
  status: string | null,
  limit: number,
) {
  let query = auth.supabase
    .from("attendance_correction_requests")
    .select(
      "id, requester_id, employee_id, work_date, operation, target_punch_id, proposed_type, proposed_occurred_at, reason, status, reviewer_id, decision_note, created_at, decided_at",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throwAttendanceDatabaseError(error);
  return (data as CorrectionRow[]).map(mapCorrection);
}

export async function decideCorrection(
  auth: AttendanceAuth,
  requestId: string,
  decision: "approved" | "rejected",
  note: string | null,
) {
  const { data, error } = await auth.supabase.rpc(
    "apply_attendance_correction",
    {
      p_request_id: requestId,
      p_decision: decision,
      p_note: note,
    },
  );
  if (error) throwAttendanceDatabaseError(error);
  return data as AttendanceDaySummary & {
    requestId: string;
    status: "approved" | "rejected";
  };
}

type ScheduleRow = {
  id: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
};

type SegmentRow = {
  id: string;
  schedule_id: string;
  iso_weekday: number;
  kind: "work" | "break";
  start_time: string;
  end_time: string;
  position: number;
};

type AssignmentRow = {
  id: string;
  employee_id: string;
  schedule_id: string;
  effective_from: string;
  effective_to: string | null;
};

export async function getWorkSchedules(auth: AttendanceAuth) {
  const [settingsResult, schedulesResult, segmentsResult, assignmentsResult] =
    await Promise.all([
      auth.supabase
        .from("attendance_settings")
        .select("timezone, grace_minutes, max_sessions")
        .single(),
      auth.supabase
        .from("work_schedules")
        .select("id, name, is_default, is_active")
        .order("name"),
      auth.supabase
        .from("work_schedule_segments")
        .select("id, schedule_id, iso_weekday, kind, start_time, end_time, position")
        .order("iso_weekday")
        .order("position"),
      auth.supabase
        .from("employee_schedule_assignments")
        .select("id, employee_id, schedule_id, effective_from, effective_to")
        .order("effective_from", { ascending: false }),
    ]);
  const error =
    settingsResult.error ||
    schedulesResult.error ||
    segmentsResult.error ||
    assignmentsResult.error;
  if (error) throwAttendanceDatabaseError(error);

  const settings: AttendanceSettings = {
    timezone: settingsResult.data.timezone,
    graceMinutes: settingsResult.data.grace_minutes,
    maxSessions: settingsResult.data.max_sessions,
  };
  const segments = segmentsResult.data as SegmentRow[];
  const assignments = assignmentsResult.data as AssignmentRow[];
  const schedules: WorkSchedule[] = (schedulesResult.data as ScheduleRow[]).map(
    (schedule) => ({
      id: schedule.id,
      name: schedule.name,
      isDefault: schedule.is_default,
      isActive: schedule.is_active,
      segments: segments
        .filter((segment) => segment.schedule_id === schedule.id)
        .map((segment) => ({
          id: segment.id,
          isoWeekday: segment.iso_weekday,
          kind: segment.kind,
          startTime: segment.start_time,
          endTime: segment.end_time,
          position: segment.position,
        })),
      assignments: assignments
        .filter((assignment) => assignment.schedule_id === schedule.id)
        .map((assignment) => ({
          id: assignment.id,
          employeeId: assignment.employee_id,
          scheduleId: assignment.schedule_id,
          effectiveFrom: assignment.effective_from,
          effectiveTo: assignment.effective_to,
        })),
    }),
  );
  return { settings, schedules };
}

export async function saveWorkSchedule(
  auth: AttendanceAuth,
  payload: {
    schedule: Omit<WorkSchedule, "id"> & { id?: string };
    settings?: AttendanceSettings;
  },
) {
  const { schedule, settings } = payload;
  const { data, error } = await auth.supabase.rpc("save_work_schedule", {
    p_schedule: {
      id: schedule.id,
      name: schedule.name,
      isDefault: schedule.isDefault,
      isActive: schedule.isActive,
    },
    p_segments: schedule.segments,
    p_assignments: schedule.assignments ?? null,
    p_settings: settings ?? null,
  });
  if (error) throwAttendanceDatabaseError(error);
  return data as { id: string };
}
