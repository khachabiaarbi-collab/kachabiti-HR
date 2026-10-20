import { NextResponse } from "next/server";

import {
  attendanceErrorResponse,
  invalidRequest,
  readJsonObject,
} from "@/lib/attendance-api";
import { isUuid } from "@/lib/attendance";
import {
  AttendanceServerError,
  punchAttendance,
  requireAttendanceAuth,
} from "@/lib/attendance-server";
import { guardPunchLocation, parsePunchCoords } from "@/lib/work-location-guard";
import {
  listWorkLocations,
  recordPunchLocation,
} from "@/lib/work-locations-server";

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
    const locations = await listWorkLocations(auth);
    const coords = parsePunchCoords(body);
    const guard = guardPunchLocation(locations, coords);
    if (!guard.ok) {
      throw new AttendanceServerError(
        guard.code,
        422,
        guard.code === "LOCATION_REQUIRED"
          ? "Turn on location to punch at the workplace."
          : "You can only punch from a configured work location.",
      );
    }
    const result = await punchAttendance(
      auth,
      body.idempotencyKey,
      (body.expectedLatestPunchId as string | null | undefined) ?? null,
    );
    if (guard.coords && !result.replayed) {
      await recordPunchLocation(
        result.punchId,
        guard.coords,
        guard.location?.id ?? null,
      );
    }
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
