import { NextResponse } from "next/server";

import { attendanceErrorResponse } from "@/lib/attendance-api";
import { requireAttendanceAuth } from "@/lib/attendance-server";
import { getSelfLeaveHours, getTeamLeaveHours } from "@/lib/leave-hours-server";

export async function GET(request: Request) {
  try {
    const month = new URL(request.url).searchParams.get("month");
    if (month) {
      const auth = await requireAttendanceAuth(true);
      return NextResponse.json({
        month,
        items: await getTeamLeaveHours(month),
        viewerId: auth.userId,
      });
    }
    return NextResponse.json(await getSelfLeaveHours());
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
