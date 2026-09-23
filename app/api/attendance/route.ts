import { NextResponse } from "next/server";

import { attendanceErrorResponse, invalidRequest } from "@/lib/attendance-api";
import {
  ATTENDANCE_MAX_RANGE_DAYS,
  ATTENDANCE_TIMEZONE,
  dateRangeDays,
  isIsoDate,
  isUuid,
} from "@/lib/attendance";
import {
  getAttendanceReport,
  requireAttendanceAuth,
} from "@/lib/attendance-server";

function tunisDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function daysBefore(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const to = params.get("to") ?? tunisDate();
    const from = params.get("from") ?? daysBefore(to, 29);
    const employeeId = params.get("employeeId");
    const departmentId = params.get("departmentId");
    const status = params.get("status");
    const page = Number(params.get("page") ?? "1");
    const pageSize = Number(params.get("pageSize") ?? "25");

    if (
      !isIsoDate(from) ||
      !isIsoDate(to) ||
      from > to ||
      dateRangeDays(from, to) > ATTENDANCE_MAX_RANGE_DAYS + 1
    ) {
      return invalidRequest("Choose a valid date range of at most 93 days.");
    }
    if (
      (employeeId && !isUuid(employeeId)) ||
      (departmentId && !isUuid(departmentId))
    ) {
      return invalidRequest("An employee or department filter is invalid.");
    }
    if (
      status &&
      !["absent", "present", "locked", "incomplete"].includes(status)
    ) {
      return invalidRequest("The attendance status filter is invalid.");
    }
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return invalidRequest("The requested page is invalid.");
    }

    const auth = await requireAttendanceAuth(true);
    return NextResponse.json(
      await getAttendanceReport(auth, {
        from,
        to,
        employeeId,
        departmentId,
        status,
        page,
        pageSize,
      }),
    );
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
