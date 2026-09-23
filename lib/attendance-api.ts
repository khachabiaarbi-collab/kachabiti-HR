import "server-only";

import { NextResponse } from "next/server";

import {
  AttendanceServerError,
  throwAttendanceDatabaseError,
} from "@/lib/attendance-server";

export function attendanceErrorResponse(error: unknown) {
  if (error instanceof AttendanceServerError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    {
      error: {
        code: "SERVER_ERROR",
        message: "The attendance service is temporarily unavailable.",
      },
    },
    { status: 500 },
  );
}

export async function readJsonObject(request: Request) {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function invalidRequest(message: string) {
  return NextResponse.json(
    { error: { code: "INVALID_REQUEST", message } },
    { status: 400 },
  );
}

export { throwAttendanceDatabaseError };
