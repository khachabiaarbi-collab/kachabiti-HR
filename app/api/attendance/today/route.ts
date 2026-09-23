import { NextResponse } from "next/server";

import { attendanceErrorResponse } from "@/lib/attendance-api";
import {
  getTodayAttendance,
  requireAttendanceAuth,
} from "@/lib/attendance-server";

export async function GET() {
  try {
    const auth = await requireAttendanceAuth();
    return NextResponse.json(await getTodayAttendance(auth));
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
