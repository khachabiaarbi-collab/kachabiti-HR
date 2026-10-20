import { NextResponse } from "next/server";

import {
  attendanceErrorResponse,
  invalidRequest,
  readJsonObject,
} from "@/lib/attendance-api";
import { isUuid } from "@/lib/attendance";
import {
  AttendanceServerError,
  requireAttendanceAuth,
} from "@/lib/attendance-server";
import { parseWorkLocationDraft } from "@/lib/work-location-guard";
import {
  deleteWorkLocation,
  listWorkLocations,
  saveWorkLocation,
} from "@/lib/work-locations-server";

export async function GET() {
  try {
    const auth = await requireAttendanceAuth();
    const locations = await listWorkLocations(auth);
    return NextResponse.json({
      locations: auth.isStaff ? locations : locations.filter((item) => item.isActive),
    });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAttendanceAuth(true);
    const body = await readJsonObject(request);
    if (!body) return invalidRequest("A work location is required.");
    const draft = parseWorkLocationDraft(body);
    if (!draft) {
      throw new AttendanceServerError(
        "INVALID_LOCATION",
        400,
        "Enter a name, coordinates, and a radius between 30 and 2000 meters.",
      );
    }
    const id = typeof body.id === "string" && isUuid(body.id) ? body.id : undefined;
    await saveWorkLocation(auth, { ...draft, id });
    return NextResponse.json({ locations: await listWorkLocations(auth) });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireAttendanceAuth(true);
    const id = new URL(request.url).searchParams.get("id");
    if (!id || !isUuid(id)) return invalidRequest("A location id is required.");
    await deleteWorkLocation(auth, id);
    return NextResponse.json({ locations: await listWorkLocations(auth) });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
