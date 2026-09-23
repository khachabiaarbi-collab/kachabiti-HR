import { NextResponse } from "next/server";

import {
  attendanceErrorResponse,
  invalidRequest,
  readJsonObject,
} from "@/lib/attendance-api";
import {
  ATTENDANCE_TIMEZONE,
  isIsoDate,
  isUuid,
  type AttendanceSettings,
  type ScheduleAssignment,
  type ScheduleSegment,
  type WorkSchedule,
} from "@/lib/attendance";
import {
  getWorkSchedules,
  requireAttendanceAuth,
  saveWorkSchedule,
} from "@/lib/attendance-server";

const TIME = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

function validSegment(value: unknown): value is ScheduleSegment {
  if (!value || typeof value !== "object") return false;
  const segment = value as Record<string, unknown>;
  return (
    Number.isInteger(segment.isoWeekday) &&
    Number(segment.isoWeekday) >= 1 &&
    Number(segment.isoWeekday) <= 7 &&
    (segment.kind === "work" || segment.kind === "break") &&
    typeof segment.startTime === "string" &&
    typeof segment.endTime === "string" &&
    TIME.test(segment.startTime) &&
    TIME.test(segment.endTime) &&
    segment.startTime < segment.endTime &&
    Number.isInteger(segment.position) &&
    Number(segment.position) >= 0
  );
}

function validAssignment(value: unknown): value is ScheduleAssignment {
  if (!value || typeof value !== "object") return false;
  const assignment = value as Record<string, unknown>;
  return (
    isUuid(assignment.employeeId) &&
    isIsoDate(assignment.effectiveFrom) &&
    (assignment.effectiveTo == null ||
      (isIsoDate(assignment.effectiveTo) &&
        assignment.effectiveTo >= assignment.effectiveFrom))
  );
}

function parseSettings(value: unknown): AttendanceSettings | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const settings = value as Record<string, unknown>;
  if (
    settings.timezone !== ATTENDANCE_TIMEZONE ||
    !Number.isInteger(settings.graceMinutes) ||
    Number(settings.graceMinutes) < 0 ||
    Number(settings.graceMinutes) > 120 ||
    !Number.isInteger(settings.maxSessions) ||
    Number(settings.maxSessions) < 1 ||
    Number(settings.maxSessions) > 5
  ) {
    return undefined;
  }
  return settings as AttendanceSettings;
}

export async function GET() {
  try {
    const auth = await requireAttendanceAuth(true);
    return NextResponse.json(await getWorkSchedules(auth));
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await readJsonObject(request);
    const scheduleValue =
      body?.schedule && typeof body.schedule === "object"
        ? (body.schedule as Record<string, unknown>)
        : null;
    const settings = parseSettings(body?.settings);
    if (
      !scheduleValue ||
      (scheduleValue.id != null && !isUuid(scheduleValue.id)) ||
      typeof scheduleValue.name !== "string" ||
      !scheduleValue.name.trim() ||
      scheduleValue.name.trim().length > 100 ||
      typeof scheduleValue.isDefault !== "boolean" ||
      typeof scheduleValue.isActive !== "boolean" ||
      !Array.isArray(scheduleValue.segments) ||
      !scheduleValue.segments.every(validSegment) ||
      (scheduleValue.assignments != null &&
        (!Array.isArray(scheduleValue.assignments) ||
          !scheduleValue.assignments.every(validAssignment))) ||
      (body?.settings != null && !settings)
    ) {
      return invalidRequest("The schedule or attendance settings are invalid.");
    }

    const schedule = {
      id: scheduleValue.id as string | undefined,
      name: scheduleValue.name.trim(),
      isDefault: scheduleValue.isDefault,
      isActive: scheduleValue.isActive,
      segments: scheduleValue.segments,
      assignments: scheduleValue.assignments,
    } as Omit<WorkSchedule, "id"> & { id?: string };

    const auth = await requireAttendanceAuth(true);
    const result = await saveWorkSchedule(auth, { schedule, settings });
    return NextResponse.json(result, { status: schedule.id ? 200 : 201 });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
