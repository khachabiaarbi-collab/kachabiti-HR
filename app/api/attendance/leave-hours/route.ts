import { NextResponse } from "next/server";

import { attendanceErrorResponse } from "@/lib/attendance-api";
import { requireAttendanceAuth } from "@/lib/attendance-server";
import { getSelfLeaveHours, getStaffLeaveBalances, getTeamLeaveHours } from "@/lib/leave-hours-server";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.get("balances") === "1") {
      return NextResponse.json({ items: await getStaffLeaveBalances() });
    }
    const month = params.get("month");
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
