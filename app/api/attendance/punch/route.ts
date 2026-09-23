import { NextResponse } from "next/server";

import {
  attendanceErrorResponse,
  invalidRequest,
  readJsonObject,
} from "@/lib/attendance-api";
import { isUuid } from "@/lib/attendance";
import {
  punchAttendance,
  requireAttendanceAuth,
} from "@/lib/attendance-server";

export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    if (!body || !isUuid(body.idempotencyKey)) {
      return invalidRequest("A valid idempotency key is required.");
    }
    if (
      body.expectedLatestPunchId !== null &&
      body.expectedLatestPunchId !== undefined &&
      !isUuid(body.expectedLatestPunchId)
    ) {
      return invalidRequest("The latest punch token is invalid.");
    }

    const auth = await requireAttendanceAuth();
    const result = await punchAttendance(
      auth,
      body.idempotencyKey,
      (body.expectedLatestPunchId as string | null | undefined) ?? null,
    );
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
